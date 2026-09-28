import { describe, it, expect } from 'vitest';
import type * as http from 'node:http';
import { startHttpProxy } from 'mcpose';
import type { LocalTool } from 'mcpose';
import { createMockBackendClient } from 'mcpose/testing';
import { createAuditMiddleware } from '../middleware.js';
import { createDefaultSigningKeyProvider } from '../signingKey.js';
import { createSensitivityResolver } from '../sensitivity.js';
import { verifyAuditChain, verifyManifestSignature } from '../verify.js';
import type { AuditEvent, AuditOptions, ReplayManifest } from '../types.js';

/**
 * A call that fails is only a `rejected` event when its error carries a
 * member of the closed `RejectionReason` union.
 *
 * The failing call is a LOCAL tool handler (ADR-0007), so it runs inside the
 * pipeline and the audit middleware observes it there, exactly as the tool
 * call in the issue does. The error is shaped like an `McpError` from
 * `rejectionMcpError()` without importing the SDK: the middleware
 * duck-types `err.data.rejectionReason`.
 */

const MESSAGE = 'ledger pool reset: no capacity';

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

function port(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

/** A local tool that always fails, carrying `reason` in the error's data. */
function failingLocalTool(reason: string): LocalTool {
  return {
    tool: { name: 'ledger_entry', inputSchema: { type: 'object' } },
    handler: async () => {
      throw Object.assign(new Error(MESSAGE), {
        code: -32603,
        data: { rejectionReason: reason },
      });
    },
  };
}

const signingKey = createDefaultSigningKeyProvider('test-secret');

async function harness(reason: string, overrides: Partial<AuditOptions> = {}) {
  const events: AuditEvent[] = [];
  const audit = createAuditMiddleware({
    signingKey,
    sensitivityResolver: createSensitivityResolver({ ledger_entry: 'low' }),
    onEvent: (e) => void events.push(e),
    ...overrides,
  });
  const server = await startHttpProxy(
    createMockBackendClient(),
    {
      name: 'audit-rejection-test',
      localTools: [failingLocalTool(reason)],
      toolMiddleware: [audit.middleware],
    },
    { port: 0, path: '/mcp' },
  );
  const baseUrl = `http://localhost:${port(server)}/mcp`;
  const init = await fetch(baseUrl, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.1' },
      },
    }),
  });
  await init.text();
  const sessionId = init.headers.get('mcp-session-id')!;
  expect(sessionId).toBeTruthy();

  const call = await fetch(baseUrl, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ledger_entry', arguments: { amount: 10 } },
    }),
  });
  await call.text();
  const manifest: ReplayManifest | undefined =
    await audit.closeSession(sessionId);

  return {
    events,
    manifest,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('rejection classification — only a RejectionReason member is a rejection (#238)', () => {
  it('records an error carrying a reason outside the union as an error, with the real message', async () => {
    const h = await harness('LEDGER_POOL_RESET');
    try {
      expect(h.events).toHaveLength(1);
      const event = h.events[0]!;
      expect(event.outcome).toBe('error');
      // The unvalidated string is not a covered field of this event: an
      // omitted key keeps the preimage the event has always had
      // (ADR-0012), and the classification that ADR-0004's `error` field
      // exists for is restored.
      expect(Object.hasOwn(event, 'rejectionReason')).toBe(false);
      expect(event.error).toEqual({ name: 'Error', message: MESSAGE });
      expect(event.tool).toBe('ledger_entry');
      expect(await verifyAuditChain(h.events, signingKey)).toEqual({
        valid: true,
      });
      expect(h.manifest?.eventCount).toBe(1);
      expect(await verifyManifestSignature(h.manifest!, signingKey)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('records a reason inside the union as a rejection, unchanged', async () => {
    const h = await harness('POLICY_DENIED');
    try {
      expect(h.events).toHaveLength(1);
      const event = h.events[0]!;
      expect(event.outcome).toBe('rejected');
      expect(event.rejectionReason).toBe('POLICY_DENIED');
      expect(Object.hasOwn(event, 'error')).toBe(false);
      expect(await verifyAuditChain(h.events, signingKey)).toEqual({
        valid: true,
      });
    } finally {
      await h.close();
    }
  });

  it('records a reason that is a prototype key as an error, not a rejection', async () => {
    const h = await harness('constructor');
    try {
      expect(h.events).toHaveLength(1);
      expect(h.events[0]!.outcome).toBe('error');
      expect(Object.hasOwn(h.events[0]!, 'rejectionReason')).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('includeRejections: false still drops a rejection, and still records a non-member as an error', async () => {
    const dropped = await harness('POLICY_DENIED', {
      includeRejections: false,
    });
    try {
      expect(dropped.events).toEqual([]);
    } finally {
      await dropped.close();
    }

    const recorded = await harness('LEDGER_POOL_RESET', {
      includeRejections: false,
    });
    try {
      expect(recorded.events).toHaveLength(1);
      expect(recorded.events[0]!.outcome).toBe('error');
      expect(recorded.events[0]!.error).toEqual({
        name: 'Error',
        message: MESSAGE,
      });
    } finally {
      await recorded.close();
    }
  });
});
