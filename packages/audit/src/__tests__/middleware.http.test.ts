import { describe, it, expect } from 'vitest';
import type * as http from 'node:http';
import { startHttpProxy } from 'mcpose';
import type { LocalTool } from 'mcpose';
import { createMockBackendClient } from 'mcpose/testing';
import { createAuditMiddleware } from '../middleware.js';
import { createDefaultSigningKeyProvider } from '../signingKey.js';
import { verifyAuditChain } from '../verify.js';
import type { AuditEvent, ReplayManifest } from '../types.js';

/**
 * End-to-end regression for #168 over real loopback HTTP: a session torn
 * down (client DELETE or TTL expiry) while a tool call is still inside its
 * handler must still seal that call into the manifest, after any events
 * the session already recorded.
 */

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function rpc(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function port(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

async function harness(sessionTtlMs: number) {
  const events: AuditEvent[] = [];
  const manifests: Promise<ReplayManifest | undefined>[] = [];
  const closed = deferred<string>();
  const entered = deferred();
  const release = deferred();
  const audit = createAuditMiddleware({
    signingKey: createDefaultSigningKeyProvider('test-secret'),
    sensitivityResolver: () => 'low',
    onEvent: (e) => void events.push(e),
  });
  const slow: LocalTool = {
    tool: { name: 'slow', inputSchema: { type: 'object' } },
    handler: async (params) => {
      if (params.arguments?.['block'] === true) {
        entered.resolve();
        await release.promise;
      }
      return { content: [] };
    },
  };
  const server = await startHttpProxy(
    createMockBackendClient(),
    {
      name: 'audit-http-test',
      localTools: [slow],
      toolMiddleware: [audit.middleware],
    },
    {
      port: 0,
      path: '/mcp',
      sessionTtlMs,
      onSessionClosed: (id) => {
        manifests.push(audit.closeSession(id));
        closed.resolve(id);
      },
    },
  );
  const baseUrl = `http://localhost:${port(server)}/mcp`;
  const init = await fetch(baseUrl, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: rpc(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    }),
  });
  await init.text();
  const sessionId = init.headers.get('mcp-session-id')!;
  expect(sessionId).toBeTruthy();
  const headers = { ...MCP_HEADERS, 'mcp-session-id': sessionId };
  const call = (id: number, block: boolean) =>
    fetch(baseUrl, {
      method: 'POST',
      headers,
      body: rpc(id, 'tools/call', { name: 'slow', arguments: { block } }),
    })
      .then((r) => r.text())
      .catch(() => undefined);

  return {
    events,
    manifests,
    closed,
    entered,
    release,
    sessionId,
    headers,
    baseUrl,
    call,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function expectSealed(h: Awaited<ReturnType<typeof harness>>) {
  expect(h.manifests).toHaveLength(1);
  const manifest = await h.manifests[0];
  expect(manifest?.sessionId).toBe(h.sessionId);
  expect(manifest?.eventCount).toBe(2);
  expect(h.events.map((e) => e.replayManifestPosition)).toEqual([0, 1]);
  expect(h.events.every((e) => e.sessionId === h.sessionId)).toBe(true);
  expect(
    await verifyAuditChain(
      h.events,
      createDefaultSigningKeyProvider('test-secret'),
    ),
  ).toEqual({ valid: true });
}

describe('audit middleware over HTTP — teardown during a blocked call (#168)', () => {
  it('client DELETE during a blocked call still seals it into the manifest', async () => {
    const h = await harness(60_000);
    try {
      await h.call(2, false);
      expect(h.events).toHaveLength(1);

      const blocked = h.call(3, true);
      await h.entered.promise;

      const del = await fetch(h.baseUrl, {
        method: 'DELETE',
        headers: h.headers,
      });
      expect(del.status).toBeLessThan(500);
      expect(await h.closed.promise).toBe(h.sessionId);

      h.release.resolve();
      await blocked;
      await expectSealed(h);
    } finally {
      h.release.resolve();
      await h.close();
    }
  });

  it('TTL expiry during a blocked call still seals it into the manifest', async () => {
    const h = await harness(150);
    try {
      await h.call(2, false);
      const blocked = h.call(3, true);
      await h.entered.promise;

      expect(await h.closed.promise).toBe(h.sessionId);

      h.release.resolve();
      await blocked;
      await expectSealed(h);
    } finally {
      h.release.resolve();
      await h.close();
    }
  });
});
