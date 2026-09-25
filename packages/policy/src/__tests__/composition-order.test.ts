import { describe, it, expect, vi } from 'vitest';
import { createProxyServer } from 'mcpose';
import type { BackendClient } from 'mcpose';
import {
  createAuditMiddleware,
  createDefaultSigningKeyProvider,
  createSensitivityResolver,
} from '@mcpose/audit';
import type { AuditEvent, AuditMiddlewareHandle } from '@mcpose/audit';
import { createPolicyMiddleware } from '../index.js';
import type { PolicyOptions } from '../index.js';

/**
 * Integration coverage for the arrays the package README recommends.
 *
 * The README tells a host to write `[policy.middleware, audit.middleware]`,
 * and core applies a `ProxyOptions` array through `pipe`, in
 * response-processing order (ADR-0002).
 * Whether that claim is right is not visible from inside this package: it is a
 * property of how the two middlewares end up wrapped, so it is checked here by
 * running the documented configuration through the real pipeline.
 * The failure mode is silent in both directions.
 * A reversed array still refuses the call and still tells the client why, and
 * the only symptom is an audit trail with no record of the attempt.
 */

/** The README's rule shape: one public allow rule, so an unmapped name is denied. */
const options: PolicyOptions = {
  rules: [
    {
      id: 'public-readonly',
      effect: 'allow',
      roles: '*',
      tools: ['read_public'],
    },
  ],
};

function makeAudit(events: AuditEvent[]): AuditMiddlewareHandle {
  return createAuditMiddleware({
    signingKey: createDefaultSigningKeyProvider('test-secret'),
    sensitivityResolver: createSensitivityResolver({}),
    onEvent: (event) => {
      events.push(event);
    },
  });
}

function makeBackend(): {
  backend: BackendClient;
  callTool: ReturnType<typeof vi.fn>;
  getPrompt: ReturnType<typeof vi.fn>;
} {
  const callTool = vi.fn(async () => ({ content: [] }));
  const getPrompt = vi.fn(async () => ({ messages: [] }));
  const backend = {
    getServerCapabilities: () => ({ tools: {}, prompts: {} }),
    listTools: async () => ({
      tools: [
        {
          name: 'read_public',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }),
    callTool,
    listPrompts: async () => ({ prompts: [{ name: 'brief' }] }),
    getPrompt,
  } as unknown as BackendClient;
  return { backend, callTool, getPrompt };
}

/** Invokes a registered handler directly via `_requestHandlers` — no transport needed. */
async function invokeHandler(
  server: ReturnType<typeof createProxyServer>,
  method: string,
  params: Record<string, unknown> = {},
) {
  const { _requestHandlers: handlers } = server as unknown as {
    _requestHandlers: Map<
      string,
      (
        req: { method: string; params: Record<string, unknown> },
        extra: object,
      ) => Promise<unknown>
    >;
  };
  const handler = handlers.get(method);
  if (!handler) throw new Error(`No handler registered for method: ${method}`);
  return handler({ method, params }, {});
}

describe('documented composition order — toolMiddleware', () => {
  it('audits the denial the README arranges for', async () => {
    const events: AuditEvent[] = [];
    const audit = makeAudit(events);
    const policy = createPolicyMiddleware(options);
    const { backend, callTool } = makeBackend();

    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [policy.middleware, audit.middleware],
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'wire_funds',
        arguments: {},
      }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'POLICY_DENIED' } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'wire_funds',
      outcome: 'rejected',
      rejectionReason: 'POLICY_DENIED',
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('loses the record when audit is wrapped inside policy instead of outside', async () => {
    const events: AuditEvent[] = [];
    const audit = makeAudit(events);
    const policy = createPolicyMiddleware(options);
    const { backend } = makeBackend();

    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [audit.middleware, policy.middleware],
    });

    // The caller is still refused, and still told why: the ordering mistake
    // costs the trail and nothing else, which is what makes it hard to notice.
    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'wire_funds',
        arguments: {},
      }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'POLICY_DENIED' } });

    expect(events).toHaveLength(0);
  });
});

describe('documented composition order — promptMiddleware', () => {
  it('audits a denied prompt fetch, in the same order rule as tools', async () => {
    const events: AuditEvent[] = [];
    const audit = makeAudit(events);
    const policy = createPolicyMiddleware(options);
    const { backend, getPrompt } = makeBackend();

    const server = createProxyServer(backend, {
      name: 'test-server',
      promptMiddleware: [policy.promptMiddleware, audit.promptMiddleware],
    });

    await expect(
      invokeHandler(server, 'prompts/get', { name: 'brief' }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'POLICY_DENIED' } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'brief',
      kind: 'prompt',
      outcome: 'rejected',
      rejectionReason: 'POLICY_DENIED',
    });
    expect(getPrompt).not.toHaveBeenCalled();
  });
});
