import { describe, it, expect, vi } from 'vitest';
import { createAuditMiddleware } from '../middleware.js';
import { createDefaultSigningKeyProvider } from '../signingKey.js';
import { createSensitivityResolver } from '../sensitivity.js';
import { verifyAuditChain, verifyManifestSignature } from '../verify.js';
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

// Every context carries a proxy identity: it is a required covered field, and
// the middleware rejects a context without one at the pre-call stage (ADR-0019).
const defaultProxy = { name: 'test-proxy', version: '0.0.0' };

function makeCtx(sessionId?: string) {
  return createProxyContext({
    transport: 'http',
    identity,
    sessionId,
    proxy: defaultProxy,
  });
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

  it('a throwing onAuditError reporter does not fail a successful call', async () => {
    const onAuditError = vi.fn(() => {
      throw new Error('reporter down');
    });
    const { middleware } = createAuditMiddleware(
      makeOptions({
        onEvent: () => {
          throw new Error('sink down');
        },
        onAuditError,
      }),
    );

    await expect(
      middleware(
        makeReq('search'),
        async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        makeCtx('s1'),
      ),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(onAuditError).toHaveBeenCalledTimes(1);
  });

  it('a throwing onAuditError reporter does not mask the upstream error', async () => {
    const upstreamError = new Error('upstream down');
    const onAuditError = vi.fn(() => {
      throw new Error('reporter down');
    });
    const { middleware } = createAuditMiddleware(
      makeOptions({
        onEvent: () => {
          throw new Error('sink down');
        },
        onAuditError,
      }),
    );

    await expect(
      middleware(
        makeReq('search'),
        async () => {
          throw upstreamError;
        },
        makeCtx('s1'),
      ),
    ).rejects.toBe(upstreamError);
    expect(onAuditError).toHaveBeenCalledTimes(1);
  });

  it('a throwing onAuditError reporter keeps the sensitivity fallback and event', async () => {
    const events: AuditEvent[] = [];
    const onAuditError = vi.fn(() => {
      throw new Error('reporter down');
    });
    const { middleware } = createAuditMiddleware(
      makeOptions({
        sensitivityResolver: () => {
          throw new Error('resolver bug');
        },
        onEvent: (event) => {
          events.push(event);
        },
        onAuditError,
      }),
    );

    await expect(
      middleware(
        makeReq('search', { ssn: '123-45-6789' }),
        async () => ({ content: [] }),
        makeCtx('s1'),
      ),
    ).resolves.toEqual({ content: [] });
    expect(onAuditError).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.sensitivityTier).toBe('high');
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
    expect(events[0]!.inputHash).toMatch(/^[0-9a-f]{64}$/);
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
    expect(events[0]!.sensitivityTier).toBe('high');
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

    expect(events[0]!.outcome).toBe('error');
    expect(events[0]!.error).toEqual({
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
    expect(events[0]!.outcome).toBe('rejected');
    expect(events[0]!.rejectionReason).toBe('TOOL_HIDDEN');
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

describe('createAuditMiddleware — close during an in-flight call (#168)', () => {
  function deferred<T = void>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('closeSession waits for admitted calls, so the manifest covers them', async () => {
    const events: AuditEvent[] = [];
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({ onEvent: (e) => void events.push(e) }),
    );

    // An earlier completed event, then a call blocked inside the upstream.
    await middleware(
      makeReq('search'),
      async () => ({ content: [] }),
      makeCtx('s'),
    );
    const entered = deferred();
    const release = deferred();
    const blocked = middleware(
      makeReq('search'),
      async () => {
        entered.resolve();
        await release.promise;
        return { content: [] };
      },
      makeCtx('s'),
    );
    await entered.promise;

    const closing = closeSession('s');
    // The close must not settle while the call is still in flight.
    let settled = false;
    void closing.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    release.resolve();
    await blocked;
    const manifest = await closing;

    expect(events.map((e) => e.replayManifestPosition)).toEqual([0, 1]);
    expect(manifest?.eventCount).toBe(2);
    expect(manifest?.merkleProofs).toHaveLength(2);
    expect(await verifyAuditChain(events, signingKey)).toEqual({ valid: true });
    // Sealed once: the session is gone afterwards.
    expect(await closeSession('s')).toBeUndefined();
  });

  it('waits for a pending onEvent sink before sealing', async () => {
    const persisted = deferred();
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({ onEvent: () => persisted.promise }),
    );
    const call = middleware(
      makeReq('search'),
      async () => ({ content: [] }),
      makeCtx('s'),
    );
    await new Promise((r) => setTimeout(r, 0));
    const closing = closeSession('s');
    let settled = false;
    void closing.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    persisted.resolve();
    await call;
    expect((await closing)?.eventCount).toBe(1);
  });

  it('counts a call as in flight from before subkey derivation, not after', async () => {
    // The first sign() call (chain subkey derivation) blocks, so the call is
    // suspended in the pre-call await when close arrives. It must still be
    // sealed into the manifest rather than resurrect the session afterwards.
    const release = deferred();
    const inner = createDefaultSigningKeyProvider('test-secret');
    let first = true;
    const slowKey: typeof inner = {
      keyId: inner.keyId,
      algorithm: inner.algorithm,
      sign: async (payload: Buffer) => {
        if (first) {
          first = false;
          await release.promise;
        }
        return inner.sign(payload);
      },
    };
    const events: AuditEvent[] = [];
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({ signingKey: slowKey, onEvent: (e) => void events.push(e) }),
    );
    const call = middleware(
      makeReq('search'),
      async () => ({ content: [] }),
      makeCtx('s'),
    );
    const closing = closeSession('s');
    let settled = false;
    void closing.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    release.resolve();
    await call;
    expect((await closing)?.eventCount).toBe(1);
    expect(events[0]!.replayManifestPosition).toBe(0);
    expect(await closeSession('s')).toBeUndefined();
  });

  it('a rejected pre-call key fetch does not leave the session looking busy', async () => {
    const onAuditError = vi.fn();
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({
        onAuditError,
        keyStore: {
          getOrCreate: () => Promise.reject(new Error('kms down')),
          destroy: async () => ({ destroyedAt: new Date().toISOString() }),
        },
      }),
    );
    await expect(
      middleware(
        makeReq('search'),
        async () => ({ content: [] }),
        makeCtx('s'),
      ),
    ).rejects.toThrow('kms down');
    // No events, so no manifest, but the close must resolve promptly rather
    // than wait on a call that already failed.
    expect(await closeSession('s')).toBeUndefined();
    expect(onAuditError).not.toHaveBeenCalled();
  });

  it('seals after closeDrainTimeoutMs and reports each stuck call', async () => {
    const events: AuditEvent[] = [];
    const onAuditError = vi.fn();
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({
        closeDrainTimeoutMs: 20,
        onAuditError,
        onEvent: (e) => void events.push(e),
      }),
    );
    await middleware(
      makeReq('search'),
      async () => ({ content: [] }),
      makeCtx('s'),
    );
    const ctx = makeCtx('s');
    void middleware(makeReq('search'), () => new Promise(() => {}), ctx);

    const manifest = await closeSession('s');
    expect(manifest?.eventCount).toBe(1);
    expect(events).toHaveLength(1);
    expect(onAuditError).toHaveBeenCalledTimes(1);
    expect(onAuditError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(onAuditError.mock.calls[0]![1]).toEqual({
      tool: 'search',
      requestId: ctx.requestId,
      sessionId: 's',
    });
    expect(await closeSession('s')).toBeUndefined();
  });

  it('concurrent closeSession calls share one manifest', async () => {
    const { middleware, closeSession } = createAuditMiddleware(makeOptions());
    const release = deferred();
    const blocked = middleware(
      makeReq('search'),
      async () => {
        await release.promise;
        return { content: [] };
      },
      makeCtx('s'),
    );
    await new Promise((r) => setTimeout(r, 0));
    const [a, b] = [closeSession('s'), closeSession('s')];
    release.resolve();
    await blocked;
    const [ma, mb] = await Promise.all([a, b]);
    expect(ma).toBeDefined();
    expect(mb).toBe(ma);
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

describe('createAuditMiddleware — sealed state survives a failed close (#169)', () => {
  const MANIFEST_DOMAIN = 'mcpose/v2/manifest';

  /** Delegates to the real provider but rejects the first N manifest payloads. */
  function flakySigner(failures: number) {
    let remaining = failures;
    const manifestSigns = vi.fn();
    const provider: AuditOptions['signingKey'] = {
      keyId: signingKey.keyId,
      algorithm: signingKey.algorithm,
      sign: async (data) => {
        if (data.toString().includes(MANIFEST_DOMAIN)) {
          manifestSigns();
          if (remaining > 0) {
            remaining -= 1;
            throw new Error('kms unavailable');
          }
        }
        return signingKey.sign(data);
      },
    };
    return { provider, manifestSigns };
  }

  async function recordOne(
    middleware: ReturnType<typeof createAuditMiddleware>['middleware'],
    sessionId: string,
  ) {
    await middleware(
      makeReq('search'),
      async () => ({ content: [] }),
      makeCtx(sessionId),
    );
  }

  it('a one-shot signing failure is retryable and the retry delivers a valid manifest', async () => {
    const { provider } = flakySigner(1);
    const onManifest = vi.fn();
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({ signingKey: provider, onManifest }),
    );
    await recordOne(middleware, 's');

    await expect(closeSession('s')).rejects.toThrow('kms unavailable');
    expect(onManifest).not.toHaveBeenCalled();

    const manifest = await closeSession('s');
    expect(manifest).toBeDefined();
    expect(await verifyManifestSignature(manifest!, signingKey)).toBe(true);
    expect(manifest!.eventCount).toBe(1);
    expect(onManifest).toHaveBeenCalledTimes(1);
    expect(onManifest).toHaveBeenCalledWith(manifest);

    // Delivered: the sealed state is released and the id is unknown again.
    expect(await closeSession('s')).toBeUndefined();
  });

  it('a one-shot onManifest failure re-delivers the identical manifest without signing again', async () => {
    const { provider, manifestSigns } = flakySigner(0);
    const delivered: unknown[] = [];
    const onManifest = vi
      .fn()
      .mockImplementationOnce(async (manifest: unknown) => {
        delivered.push(manifest);
        throw new Error('manifest store down');
      })
      .mockImplementation(async (manifest: unknown) => {
        delivered.push(manifest);
      });
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({ signingKey: provider, onManifest }),
    );
    await recordOne(middleware, 's');

    await expect(closeSession('s')).rejects.toThrow('manifest store down');
    const manifest = await closeSession('s');

    expect(delivered).toHaveLength(2);
    // Same bytes both times: same closedAt, same signature, no second artifact.
    expect(JSON.stringify(delivered[1])).toBe(JSON.stringify(delivered[0]));
    expect(delivered[1]).toEqual(manifest);
    expect(manifestSigns).toHaveBeenCalledTimes(1);
    expect(await verifyManifestSignature(manifest!, signingKey)).toBe(true);
    expect(await closeSession('s')).toBeUndefined();
  });

  it('concurrent retries share one attempt', async () => {
    const { provider, manifestSigns } = flakySigner(1);
    const onManifest = vi.fn();
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({ signingKey: provider, onManifest }),
    );
    await recordOne(middleware, 's');
    await expect(closeSession('s')).rejects.toThrow('kms unavailable');

    const [a, b] = await Promise.all([closeSession('s'), closeSession('s')]);
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(manifestSigns).toHaveBeenCalledTimes(2);
    expect(onManifest).toHaveBeenCalledTimes(1);
  });

  it('a sealed session does not admit new calls: they start a fresh session under the id', async () => {
    const { provider } = flakySigner(1);
    const onAuditError = vi.fn();
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({ signingKey: provider, onAuditError }),
    );
    await recordOne(middleware, 's');
    await expect(closeSession('s')).rejects.toThrow('kms unavailable');

    // The id is reused while the first manifest is still undelivered.
    await recordOne(middleware, 's');
    const second = await closeSession('s');
    expect(second?.eventCount).toBe(1);
    expect(onAuditError).toHaveBeenCalledTimes(1);
    expect(String(onAuditError.mock.calls[0]![0])).toMatch(
      /replaced an undelivered manifest/,
    );
  });
});
