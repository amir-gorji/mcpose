import { describe, it, expect, vi } from 'vitest';
import { createAuditMiddleware } from '../middleware.js';
import { createDefaultSigningKeyProvider } from '../signingKey.js';
import { createSensitivityResolver } from '../sensitivity.js';
import { verifyAuditChain } from '../verify.js';
import type { AuditEvent, AuditOptions } from '../types.js';
import { createProxyContext } from 'mcpose';
import type { Identity } from 'mcpose';

/**
 * Shaped like an McpError from rejectionMcpError() without importing the
 * SDK: the middleware duck-types `err.data.rejectionReason`.
 */
function rejectionError(reason: string, message: string): Error {
  return Object.assign(new Error(message), {
    code: -32601,
    data: { rejectionReason: reason },
  });
}

const identity: Identity = {
  sub: 'user-1',
  type: 'human',
  roles: ['analyst'],
  claims: {},
  resolvedAt: '2026-06-01T00:00:00.000Z',
  source: 'jwt',
};

const signingKey = createDefaultSigningKeyProvider('test-secret');

function makeOptions(overrides: Partial<AuditOptions> = {}): AuditOptions {
  return {
    signingKey,
    sensitivityResolver: createSensitivityResolver({ search: 'low' }),
    onEvent: vi.fn(),
    ...overrides,
  };
}

function makeCtx(sessionId?: string) {
  return createProxyContext({ transport: 'http', identity, sessionId });
}

function makeReq(tool: string, args: Record<string, unknown> = {}) {
  return {
    method: 'tools/call' as const,
    params: { name: tool, arguments: args },
  };
}

describe('createAuditMiddleware — concurrency', () => {
  it('allocates unique sequential positions under 20 concurrent calls', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({
        onEvent: (e) => {
          events.push(e);
        },
      }),
    );

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        middleware(
          makeReq('search', { i }),
          async () => {
            // Random completion order so appends interleave.
            await new Promise((r) => setTimeout(r, Math.floor((i * 7) % 13)));
            return { content: [] };
          },
          makeCtx('concurrent-session'),
        ),
      ),
    );

    const positions = events
      .map((e) => e.replayManifestPosition)
      .sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i));

    // The chain must ALSO recompute — positions being unique is necessary
    // but not sufficient (prevChainHash links must be consistent too).
    const ordered = [...events].sort(
      (a, b) => a.replayManifestPosition - b.replayManifestPosition,
    );
    expect(await verifyAuditChain(ordered, signingKey)).toEqual({
      valid: true,
    });
  });
});

describe('createAuditMiddleware — never blocks the call path', () => {
  it('a throwing onEvent sink does not fail a successful call', async () => {
    const audiErrors: unknown[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({
        onEvent: () => {
          throw new Error('sink down');
        },
        onAuditError: (err) => {
          audiErrors.push(err);
        },
      }),
    );

    const result = await middleware(
      makeReq('search'),
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      makeCtx('s1'),
    );
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(audiErrors).toHaveLength(1);
  });

  it('a throwing onEvent sink does not mask the upstream error', async () => {
    const { middleware } = createAuditMiddleware(
      makeOptions({
        onEvent: () => {
          throw new Error('sink down');
        },
        onAuditError: () => {},
      }),
    );

    await expect(
      middleware(
        makeReq('search'),
        async () => {
          throw new Error('upstream down');
        },
        makeCtx('s1'),
      ),
    ).rejects.toThrow('upstream down');
  });

  it('circular and BigInt arguments still produce an event', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({
        onEvent: (e) => {
          events.push(e);
        },
      }),
    );
    const circular: Record<string, unknown> = { amount: 10n };
    circular.self = circular;

    const result = await middleware(
      makeReq('search', circular),
      async () => ({ content: [] }),
      makeCtx('s2'),
    );
    expect(result).toEqual({ content: [] });
    expect(events).toHaveLength(1);
    expect(events[0].inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a throwing sensitivityResolver degrades to high tier, not a failed call', async () => {
    const events: AuditEvent[] = [];
    const auditErrors: unknown[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({
        sensitivityResolver: () => {
          throw new Error('resolver bug');
        },
        onEvent: (e) => {
          events.push(e);
        },
        onAuditError: (err) => {
          auditErrors.push(err);
        },
      }),
    );

    const result = await middleware(
      makeReq('search', { ssn: '123-45-6789' }),
      async () => ({ content: [] }),
      makeCtx('s3'),
    );
    expect(result).toEqual({ content: [] });
    expect(events[0].sensitivityTier).toBe('high');
    expect(auditErrors).toHaveLength(1);
  });
});

describe('createAuditMiddleware — error and rejection events', () => {
  it('records structured error details, distinct outputHash per error', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({
        onEvent: (e) => {
          events.push(e);
        },
      }),
    );

    await expect(
      middleware(
        makeReq('search'),
        async () => {
          throw new TypeError('bad input');
        },
        makeCtx('e1'),
      ),
    ).rejects.toThrow('bad input');

    expect(events[0].outcome).toBe('error');
    expect(events[0].error).toEqual({
      name: 'TypeError',
      message: 'bad input',
    });
  });

  it('records outcome rejected with rejectionReason for MCP rejections', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({
        onEvent: (e) => {
          events.push(e);
        },
      }),
    );

    await expect(
      middleware(
        makeReq('hidden_tool'),
        async () => {
          throw rejectionError('TOOL_HIDDEN', 'Tool not found: hidden_tool');
        },
        makeCtx('r1'),
      ),
    ).rejects.toThrow('Tool not found: hidden_tool');

    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('rejected');
    expect(events[0].rejectionReason).toBe('TOOL_HIDDEN');
  });

  it('includeRejections: false skips rejection events and keeps positions continuous', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({
        includeRejections: false,
        onEvent: (e) => {
          events.push(e);
        },
      }),
    );
    const ctx = () => makeCtx('r2');

    await middleware(makeReq('search'), async () => ({ content: [] }), ctx());
    await expect(
      middleware(
        makeReq('hidden_tool'),
        async () => {
          throw rejectionError('TOOL_HIDDEN', 'nope');
        },
        ctx(),
      ),
    ).rejects.toThrow();
    await middleware(makeReq('search'), async () => ({ content: [] }), ctx());

    expect(events.map((e) => e.outcome)).toEqual(['success', 'success']);
    expect(events.map((e) => e.replayManifestPosition)).toEqual([0, 1]);
    expect(await verifyAuditChain(events, signingKey)).toEqual({ valid: true });
  });
});

describe('createAuditMiddleware — session hygiene', () => {
  it('closeSession is idempotent: second call returns undefined', async () => {
    const { middleware, closeSession } = createAuditMiddleware(makeOptions());
    await middleware(
      makeReq('search'),
      async () => ({ content: [] }),
      makeCtx('h1'),
    );

    expect(await closeSession('h1')).toBeDefined();
    expect(await closeSession('h1')).toBeUndefined();
  });

  it('an empty session is removed from memory on closeSession', async () => {
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({ includeRejections: false }),
    );
    // Session state is created, but the only call is a skipped rejection.
    await expect(
      middleware(
        makeReq('hidden_tool'),
        async () => {
          throw rejectionError('TOOL_HIDDEN', 'nope');
        },
        makeCtx('h2'),
      ),
    ).rejects.toThrow();

    expect(await closeSession('h2')).toBeUndefined();
    // Second close: the session must have been deleted, not retained.
    expect(await closeSession('h2')).toBeUndefined();
  });

  it('a failed subkey derivation is retryable (transient provider error)', async () => {
    let calls = 0;
    const flaky = {
      ...signingKey,
      sign: async (data: Buffer) => {
        calls += 1;
        if (calls <= 2) throw new Error('KMS unavailable');
        return signingKey.sign(data);
      },
    };
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({
        signingKey: flaky,
        onEvent: (e) => {
          events.push(e);
        },
      }),
    );

    await expect(
      middleware(
        makeReq('search'),
        async () => ({ content: [] }),
        makeCtx('k1'),
      ),
    ).rejects.toThrow('KMS unavailable');

    // Second attempt succeeds — the rejected derivation was not cached.
    await middleware(
      makeReq('search'),
      async () => ({ content: [] }),
      makeCtx('k1'),
    );
    expect(events).toHaveLength(1);
  });
});
