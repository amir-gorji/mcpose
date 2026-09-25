import { describe, it, expect, vi } from 'vitest';
import { createProxyServer } from 'mcpose';
import type { BackendClient } from 'mcpose';
import {
  createAuditMiddleware,
  createDefaultSigningKeyProvider,
  createSensitivityResolver,
} from '@mcpose/audit';
import type { AuditEvent, AuditMiddlewareHandle } from '@mcpose/audit';
import { createPolicyMiddleware } from '@mcpose/policy';
import type { PolicyOptions } from '@mcpose/policy';
import { createConsentMiddleware } from '../index.js';

/**
 * Integration coverage for the arrays the package README recommends.
 *
 * The README tells a host to write `[consent.middleware, audit.middleware]`,
 * and core applies a `ProxyOptions` array through `pipe`, in
 * response-processing order (ADR-0002).
 * Whether that claim is right is not visible from inside this package: it is a
 * property of how the two middlewares end up wrapped, so it is checked here by
 * running the documented configuration through the real pipeline.
 * A reversed array still refuses the call and still tells the client why, and
 * the only symptom is an audit trail with no record of the attempt.
 */

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
          name: 'export_customer_records',
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

/**
 * A grant-everything source, so nothing here refuses on the lookup itself.
 * `createProxyServer` resolves no identity (that is an `HttpProxyOptions` hook),
 * so these runs land on the README's "no `ctx.identity`" row, which is refused
 * as `CONSENT_MISSING` before the resolver is reached.
 * Which row fired is `consent.test.ts`'s business; this suite is only about
 * whether the audit layer saw it.
 */
function makeConsent() {
  return createConsentMiddleware({ resolveConsent: vi.fn(() => true) });
}

describe('documented composition order — toolMiddleware', () => {
  it('audits the refusal the README arranges for', async () => {
    const events: AuditEvent[] = [];
    const audit = makeAudit(events);
    const consent = makeConsent();
    const { backend, callTool } = makeBackend();

    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [consent.middleware, audit.middleware],
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'export_customer_records',
        arguments: {},
      }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'CONSENT_MISSING' } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'export_customer_records',
      outcome: 'rejected',
      rejectionReason: 'CONSENT_MISSING',
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('loses the record when audit is wrapped inside consent instead of outside', async () => {
    const events: AuditEvent[] = [];
    const audit = makeAudit(events);
    const consent = makeConsent();
    const { backend } = makeBackend();

    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [audit.middleware, consent.middleware],
    });

    // The caller is still refused, and still told why: the ordering mistake
    // costs the trail and nothing else, which is what makes it hard to notice.
    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'export_customer_records',
        arguments: {},
      }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'CONSENT_MISSING' } });

    expect(events).toHaveLength(0);
  });
});

describe('documented composition order — promptMiddleware', () => {
  it('audits a refused prompt fetch, on the same order rule as tools', async () => {
    const events: AuditEvent[] = [];
    const audit = makeAudit(events);
    const consent = makeConsent();
    const { backend, getPrompt } = makeBackend();

    const server = createProxyServer(backend, {
      name: 'test-server',
      promptMiddleware: [consent.promptMiddleware, audit.promptMiddleware],
    });

    await expect(
      invokeHandler(server, 'prompts/get', { name: 'brief' }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'CONSENT_MISSING' } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'brief',
      kind: 'prompt',
      outcome: 'rejected',
      rejectionReason: 'CONSENT_MISSING',
    });
    expect(getPrompt).not.toHaveBeenCalled();
  });
});

describe('documented composition order — consent, policy, audit', () => {
  /** A rule set that covers some other tool, so this name is denied outright. */
  const policyOptions: PolicyOptions = {
    rules: [
      {
        id: 'summaries',
        effect: 'allow',
        roles: ['admin'],
        tools: ['read_summary'],
      },
    ],
  };

  it('audits the denial, with policy answering before the consent gate is reached', async () => {
    const events: AuditEvent[] = [];
    const audit = makeAudit(events);
    const consent = makeConsent();
    const policy = createPolicyMiddleware(policyOptions);
    const { backend } = makeBackend();

    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [consent.middleware, policy.middleware, audit.middleware],
    });

    // The reason is what shows policy answered first: consent sits inside it
    // and never ran. Either way the refusal reaches the trail, because audit is
    // the outermost layer.
    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'export_customer_records',
        arguments: {},
      }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'POLICY_DENIED' } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'export_customer_records',
      outcome: 'rejected',
      rejectionReason: 'POLICY_DENIED',
    });
  });

  it('swaps the reason and keeps the record when the two gates trade places', async () => {
    const events: AuditEvent[] = [];
    const audit = makeAudit(events);
    const consent = makeConsent();
    const policy = createPolicyMiddleware(policyOptions);
    const { backend } = makeBackend();

    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [policy.middleware, consent.middleware, audit.middleware],
    });

    // The README says the two gates can go either way round and only change
    // which reason a caller sees. Audit stays last, so the trail still records
    // the refusal.
    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'export_customer_records',
        arguments: {},
      }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'CONSENT_MISSING' } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'rejected',
      rejectionReason: 'CONSENT_MISSING',
    });
  });
});
