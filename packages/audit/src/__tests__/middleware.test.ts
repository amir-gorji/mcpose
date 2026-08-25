import { describe, it, expect, vi } from 'vitest';
import { createHash, createHmac, createDecipheriv } from 'node:crypto';
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
    sensitivityResolver: createSensitivityResolver({
      search: 'low',
      transfer: 'high',
    }),
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
      middleware(
        makeReq('search'),
        async () => {
          throw new Error('upstream down');
        },
        makeCtx(),
      ),
    ).rejects.toThrow('upstream down');

    const event: AuditEvent = onEvent.mock.calls[0][0];
    expect(event.outcome).toBe('error');
  });

  it('sets replayManifestPosition sequentially within a session', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({
        onEvent: (e) => {
          events.push(e);
        },
      }),
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
      makeOptions({
        onEvent: (e) => {
          events.push(e);
        },
      }),
    );
    await middleware(
      makeReq('search'),
      async () => ({ content: [] }),
      makeCtx('s1'),
    );
    expect(events[0].chainHash).toBeTruthy();
    expect(events[0].chainHash.length).toBeGreaterThan(0);
  });

  it('each chainHash differs from the previous (chain advances)', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware(
      makeOptions({
        onEvent: (e) => {
          events.push(e);
        },
      }),
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
      makeOptions({
        onEvent: (e) => {
          events.push(e);
        },
      }),
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
      makeOptions({
        onEvent: (e) => {
          events.push(e);
        },
      }),
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
      makeOptions({
        onEvent: (e) => {
          events.push(e);
        },
      }),
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

function aesGcmDecrypt(b64: string, key: Buffer, aad: string): string {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key.subarray(0, 32), iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

/** Reproduces the documented v2 event-key derivation (see ADR-0004). */
function deriveEventKey(
  encRoot: Buffer,
  sessionId: string | undefined,
  position: number,
  eventId: string,
): Buffer {
  return createHmac('sha256', encRoot)
    .update(`mcpose/v2/eventkey\0${sessionId ?? ''}\0${position}\0${eventId}`)
    .digest();
}

describe('createAuditMiddleware — subkey confidentiality (regression)', () => {
  // Guards the fix for the keyId-as-key-material footgun: subkeys must derive
  // from the SECRET via the sign() oracle, never from the public keyId (which is
  // published in ReplayManifest.signedBy). If this regresses, a manifest-holder
  // can decrypt high-tier payloads. See ADR-0003 and ADR-0004.
  it('high-tier payload is NOT decryptable from the public keyId, but IS from the secret-derived key', async () => {
    const events: AuditEvent[] = [];
    const signingKey = createDefaultSigningKeyProvider('test-secret');
    const { middleware } = createAuditMiddleware(
      makeOptions({
        signingKey,
        onEvent: (e) => {
          events.push(e);
        },
      }),
    );

    await middleware(
      makeReq('transfer', { acct: 'secret-acct' }),
      async () => ({ content: [] }),
      makeCtx(),
    );

    const event = events[0];
    if (event.sensitivityTier !== 'high') throw new Error('expected high tier');
    const aad = `mcpose/v2/aad\0${event.id}\0input`;

    // Attacker path: keyId is public (== manifest.signedBy). The OLD scheme keyed
    // encryption off SHA256(keyIdBytes ‖ id). Prove that path no longer decrypts.
    const publicKeyId = Buffer.from(signingKey.keyId, 'hex');
    const forgedKey = createHash('sha256')
      .update(publicKeyId)
      .update(event.id)
      .digest();
    expect(() => aesGcmDecrypt(event.inputEncrypted, forgedKey, aad)).toThrow();

    // Legitimate path: encRoot is derived from the secret through the oracle and
    // is never published; only a secret-holder can reproduce it.
    const encRoot = await signingKey.sign(Buffer.from('mcpose/v2/enc'));
    const realKey = deriveEventKey(encRoot, undefined, 0, event.id);
    expect(
      JSON.parse(aesGcmDecrypt(event.inputEncrypted, realKey, aad)),
    ).toEqual({ acct: 'secret-acct' });
  });

  it('input and output ciphertexts are not swappable within an event (AAD binding)', async () => {
    const events: AuditEvent[] = [];
    const signingKey = createDefaultSigningKeyProvider('test-secret');
    const { middleware } = createAuditMiddleware(
      makeOptions({
        signingKey,
        onEvent: (e) => {
          events.push(e);
        },
      }),
    );

    await middleware(
      makeReq('transfer', { acct: 'in' }),
      async () => ({ content: [{ type: 'text', text: 'out' }] }),
      makeCtx(),
    );

    const event = events[0];
    if (event.sensitivityTier !== 'high') throw new Error('expected high tier');
    const encRoot = await signingKey.sign(Buffer.from('mcpose/v2/enc'));
    const key = deriveEventKey(encRoot, undefined, 0, event.id);

    // Correct AAD decrypts; the OTHER field's AAD must not authenticate.
    const inputAad = `mcpose/v2/aad\0${event.id}\0input`;
    const outputAad = `mcpose/v2/aad\0${event.id}\0output`;
    expect(() =>
      aesGcmDecrypt(event.inputEncrypted, key, inputAad),
    ).not.toThrow();
    expect(() => aesGcmDecrypt(event.inputEncrypted, key, outputAad)).toThrow();
    expect(() => aesGcmDecrypt(event.outputEncrypted, key, inputAad)).toThrow();
  });

  it('events at different positions get distinct keys even with a reused requestId', async () => {
    const events: AuditEvent[] = [];
    const signingKey = createDefaultSigningKeyProvider('test-secret');
    const { middleware } = createAuditMiddleware(
      makeOptions({
        signingKey,
        sensitivityResolver: () => 'high',
        onEvent: (e) => {
          events.push(e);
        },
      }),
    );

    // Deliberately reuse ONE context (and therefore one requestId).
    const ctx = makeCtx('reused-ctx-session');
    await middleware(
      makeReq('transfer', { n: 1 }),
      async () => ({ content: [] }),
      ctx,
    );
    await middleware(
      makeReq('transfer', { n: 2 }),
      async () => ({ content: [] }),
      ctx,
    );

    expect(events[0].id).toBe(events[1].id);
    const encRoot = await signingKey.sign(Buffer.from('mcpose/v2/enc'));
    const key0 = deriveEventKey(encRoot, 'reused-ctx-session', 0, events[0].id);
    const key1 = deriveEventKey(encRoot, 'reused-ctx-session', 1, events[1].id);
    expect(key0.equals(key1)).toBe(false);

    // Each event decrypts only under its own positional key.
    const [first, second] = events;
    if (first.sensitivityTier !== 'high' || second.sensitivityTier !== 'high') {
      throw new Error('expected high tier');
    }
    const aad0 = `mcpose/v2/aad\0${first.id}\0input`;
    expect(JSON.parse(aesGcmDecrypt(first.inputEncrypted, key0, aad0))).toEqual(
      { n: 1 },
    );
    expect(() => aesGcmDecrypt(second.inputEncrypted, key0, aad0)).toThrow();
  });
});
