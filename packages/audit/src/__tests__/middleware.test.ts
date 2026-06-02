import { describe, it, expect, vi } from 'vitest';
import { createAuditMiddleware } from '../middleware.js';
import { createDefaultSigningKeyProvider } from '../signingKey.js';
import { createSensitivityResolver } from '../sensitivity.js';
import type { AuditEvent, AuditOptions } from '../types.js';
import type { Identity } from 'mcpose';
import { createProxyContext } from 'mcpose';

const identity: Identity = {
  sub: 'user-1',
  type: 'human',
  roles: ['analyst'],
  claims: {},
  resolvedAt: '2026-06-01T00:00:00.000Z',
  source: 'jwt',
};

function makeOptions(overrides: Partial<AuditOptions> = {}): AuditOptions {
  return {
    signingKey: createDefaultSigningKeyProvider('test-secret'),
    sensitivityResolver: createSensitivityResolver({ search: 'low', transfer: 'high' }),
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

describe('createAuditMiddleware — tracer bullet', () => {
  it('calls onEvent after a successful tool call', async () => {
    const onEvent = vi.fn();
    const { middleware } = createAuditMiddleware(makeOptions({ onEvent }));
    const ctx = makeCtx('session-1');

    await middleware(makeReq('search'), async () => ({ content: [] }), ctx);

    expect(onEvent).toHaveBeenCalledOnce();
    const event: AuditEvent = onEvent.mock.calls[0][0];
    expect(event.tool).toBe('search');
    expect(event.outcome).toBe('success');
    expect(event.identity.sub).toBe('user-1');
    expect(event.sessionId).toBe('session-1');
    expect(event.sensitivityTier).toBe('low');
  });

  it('records error outcome when next throws', async () => {
    const onEvent = vi.fn();
    const { middleware } = createAuditMiddleware(makeOptions({ onEvent }));

    await expect(
      middleware(makeReq('search'), async () => { throw new Error('upstream down'); }, makeCtx()),
    ).rejects.toThrow('upstream down');

    const event: AuditEvent = onEvent.mock.calls[0][0];
    expect(event.outcome).toBe('error');
  });

  it('sets replayManifestPosition sequentially within a session', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({ onEvent: (e) => events.push(e) }),
    );
    const ctx = makeCtx('sess-seq');

    await middleware(makeReq('search'), async () => ({ content: [] }), ctx);
    await middleware(makeReq('search'), async () => ({ content: [] }), ctx);
    await middleware(makeReq('search'), async () => ({ content: [] }), ctx);

    expect(events.map((e) => e.replayManifestPosition)).toEqual([0, 1, 2]);
  });
});

describe('createAuditMiddleware — HMAC chain', () => {
  it('first event chainHash is non-empty', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({ onEvent: (e) => events.push(e) }),
    );
    await middleware(makeReq('search'), async () => ({ content: [] }), makeCtx('s1'));
    expect(events[0].chainHash).toBeTruthy();
    expect(events[0].chainHash.length).toBeGreaterThan(0);
  });

  it('each chainHash differs from the previous (chain advances)', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({ onEvent: (e) => events.push(e) }),
    );
    const ctx = makeCtx('s2');
    for (let i = 0; i < 5; i++) {
      await middleware(makeReq('search'), async () => ({ content: [] }), ctx);
    }
    const hashes = events.map((e) => e.chainHash);
    const unique = new Set(hashes);
    expect(unique.size).toBe(5);
  });
});

describe('createAuditMiddleware — sensitivity tiers', () => {
  it('low-tier event has inputRaw and outputRaw', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({ onEvent: (e) => events.push(e) }),
    );
    await middleware(
      makeReq('search', { q: 'hello' }),
      async () => ({ content: [{ type: 'text', text: 'result' }] }),
      makeCtx(),
    );
    const event = events[0];
    expect(event.sensitivityTier).toBe('low');
    if (event.sensitivityTier === 'low') {
      expect(event.inputRaw).toEqual({ q: 'hello' });
    }
  });

  it('high-tier event has encrypted fields, no inputRaw/outputRaw', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({ onEvent: (e) => events.push(e) }),
    );
    await middleware(
      makeReq('transfer', { amount: 1000 }),
      async () => ({ content: [] }),
      makeCtx(),
    );
    const event = events[0];
    expect(event.sensitivityTier).toBe('high');
    if (event.sensitivityTier === 'high') {
      expect(typeof event.inputEncrypted).toBe('string');
      expect(typeof event.outputEncrypted).toBe('string');
      expect('inputRaw' in event).toBe(false);
    }
  });
});

describe('createAuditMiddleware — closeSession', () => {
  it('returns undefined for unknown session', async () => {
    const { closeSession } = createAuditMiddleware(makeOptions());
    const result = await closeSession('no-such-session');
    expect(result).toBeUndefined();
  });

  it('returns undefined for session with no events', async () => {
    const { closeSession } = createAuditMiddleware(makeOptions());
    const result = await closeSession('empty-session');
    expect(result).toBeUndefined();
  });

  it('returns ReplayManifest with correct fields after events', async () => {
    const onManifest = vi.fn();
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({ onManifest }),
    );
    const ctx = makeCtx('sess-manifest');
    await middleware(makeReq('search'), async () => ({ content: [] }), ctx);
    await middleware(makeReq('search'), async () => ({ content: [] }), ctx);

    const manifest = await closeSession('sess-manifest');

    expect(manifest).toBeDefined();
    expect(manifest!.sessionId).toBe('sess-manifest');
    expect(manifest!.eventCount).toBe(2);
    expect(manifest!.merkleRoot).toBeTruthy();
    expect(manifest!.merkleProofs).toHaveLength(2);
    expect(manifest!.signature).toBeTruthy();
    expect(manifest!.signedBy).toBeTruthy();
    expect(onManifest).toHaveBeenCalledOnce();
    expect(onManifest.mock.calls[0][0]).toEqual(manifest);
  });
});

describe('createAuditMiddleware — Merkle proof', () => {
  it('proof for each event verifies against the merkle root', async () => {
    const { verifyMerkleProof } = await import('../chain.js');
    const events: AuditEvent[] = [];
    const { middleware, closeSession } = createAuditMiddleware(
      makeOptions({ onEvent: (e) => events.push(e) }),
    );
    const ctx = makeCtx('sess-merkle');
    for (let i = 0; i < 4; i++) {
      await middleware(makeReq('search'), async () => ({ content: [] }), ctx);
    }
    const manifest = await closeSession('sess-merkle');
    expect(manifest).toBeDefined();

    for (let i = 0; i < events.length; i++) {
      const valid = verifyMerkleProof(
        events[i].chainHash,
        manifest!.merkleProofs[i],
        manifest!.merkleRoot,
      );
      expect(valid).toBe(true);
    }
  });
});
