import { describe, it, expect, vi } from 'vitest';
import { createHmac, createDecipheriv } from 'node:crypto';
import { createAuditMiddleware } from '../middleware.js';
import { createDefaultSigningKeyProvider } from '../signingKey.js';
import { createInMemorySubjectKeyStore } from '../subjectKeyStore.js';
import { verifyAuditChain, verifyManifestSignature } from '../verify.js';
import { chainPreimageFields, sha256hex, stableStringify } from '../chain.js';
import type {
  AuditEvent,
  AuditOptions,
  HighAuditEvent,
  SubjectKeyStore,
} from '../types.js';
import type { Identity } from 'mcpose';
import { createProxyContext } from 'mcpose';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const proxy = { name: 'test-proxy', version: '0.0.0' };

function makeIdentity(sub: string): Identity {
  return {
    sub,
    type: 'human',
    roles: ['analyst'],
    claims: {},
    resolvedAt: '2026-06-01T00:00:00.000Z',
    source: 'jwt',
  };
}

function makeCtx(identity: Identity | undefined, sessionId?: string) {
  return createProxyContext({
    transport: 'http',
    ...(identity === undefined ? {} : { identity }),
    sessionId,
    proxy,
  });
}

function makeReq(tool: string, args: Record<string, unknown> = {}) {
  return {
    method: 'tools/call' as const,
    params: { name: tool, arguments: args },
  };
}

/**
 * Collects events, and always encrypts, so every test here exercises the
 * high-tier path where erasure has something to destroy.
 */
function makeHarness(overrides: Partial<AuditOptions> = {}) {
  const events: AuditEvent[] = [];
  const signingKey = createDefaultSigningKeyProvider('test-secret');
  const handle = createAuditMiddleware({
    signingKey,
    sensitivityResolver: () => 'high',
    onEvent: (e) => {
      events.push(e);
    },
    ...overrides,
  });
  return { events, signingKey, ...handle };
}

function aesGcmDecrypt(b64: string, key: Buffer, aad: string): string {
  const buf = Buffer.from(b64, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    buf.subarray(0, 12), // iv
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(buf.subarray(12, 28)); // tag
  return Buffer.concat([
    decipher.update(buf.subarray(28)),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Reproduces the documented event-key derivation. Erasable mode swaps only
 * the root: the label and the session/position/id inputs are unchanged.
 */
function deriveEventKey(
  root: Buffer,
  sessionId: string | undefined,
  position: number,
  eventId: string,
): Buffer {
  return createHmac('sha256', root)
    .update(`mcpose/v2/eventkey\0${sessionId ?? ''}\0${position}\0${eventId}`)
    .digest();
}

/** Reproduces the erasable-mode hash subkey derivation (ADR-0018). */
function deriveHashSubkey(subjectKey: Buffer): Buffer {
  return createHmac('sha256', subjectKey).update('mcpose/v2/hashkey').digest();
}

function decryptInput(
  event: HighAuditEvent,
  subjectKey: Buffer,
  sessionId?: string,
): unknown {
  const key = deriveEventKey(
    subjectKey,
    sessionId,
    event.replayManifestPosition,
    event.id,
  );
  return JSON.parse(
    aesGcmDecrypt(
      event.inputEncrypted,
      key,
      `mcpose/v2/aad\0${event.id}\0input`,
    ),
  );
}

function asHigh(event: AuditEvent | undefined): HighAuditEvent {
  if (event?.sensitivityTier !== 'high') throw new Error('expected high tier');
  return event;
}

// ── Chain and manifest still verify ──────────────────────────────────────────

describe('erasable mode — the chain is unaffected', () => {
  it('an erasable-mode chain and its manifest verify under the signing key', async () => {
    const keyStore = createInMemorySubjectKeyStore();
    const { events, signingKey, middleware, closeSession } = makeHarness({
      keyStore,
    });
    const ctx = makeCtx(makeIdentity('user-1'), 'sess-verify');

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

    expect(events.map((e) => e.erasable)).toEqual([true, true]);
    await expect(verifyAuditChain(events, signingKey)).resolves.toEqual({
      valid: true,
    });

    const manifest = await closeSession('sess-verify');
    expect(manifest).toBeDefined();
    await expect(verifyManifestSignature(manifest!, signingKey)).resolves.toBe(
      true,
    );
  });

  it('erasure destroys payload access and leaves the chain verifying', async () => {
    const keyStore = createInMemorySubjectKeyStore();
    const { events, signingKey, middleware } = makeHarness({ keyStore });
    const ctx = makeCtx(makeIdentity('user-1'), 'sess-erase');

    await middleware(
      makeReq('transfer', { acct: 'secret-acct' }),
      async () => ({ content: [] }),
      ctx,
    );
    const event = asHigh(events[0]);

    // Readable while the key exists.
    const before = await keyStore.getOrCreate('user-1');
    expect(decryptInput(event, before, 'sess-erase')).toEqual({
      acct: 'secret-acct',
    });

    const tombstone = await keyStore.destroy('user-1');
    expect(tombstone.destroyedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The key that comes back now is a fresh one, and it opens nothing.
    const after = await keyStore.getOrCreate('user-1');
    expect(after.equals(before)).toBe(false);
    expect(() => decryptInput(event, after, 'sess-erase')).toThrow();

    // The record itself is untouched and still verifies.
    await expect(verifyAuditChain(events, signingKey)).resolves.toEqual({
      valid: true,
    });
  });

  it('erasing one subject leaves another subject decryptable', async () => {
    const keyStore = createInMemorySubjectKeyStore();
    const { events, middleware } = makeHarness({ keyStore });

    await middleware(
      makeReq('transfer', { who: 'one' }),
      async () => ({ content: [] }),
      makeCtx(makeIdentity('user-1'), 's1'),
    );
    await middleware(
      makeReq('transfer', { who: 'two' }),
      async () => ({ content: [] }),
      makeCtx(makeIdentity('user-2'), 's2'),
    );

    const keyTwo = await keyStore.getOrCreate('user-2');
    await keyStore.destroy('user-1');
    const keyOneAfter = await keyStore.getOrCreate('user-1');

    expect(() => decryptInput(asHigh(events[0]), keyOneAfter, 's1')).toThrow();
    expect(decryptInput(asHigh(events[1]), keyTwo, 's2')).toEqual({
      who: 'two',
    });
  });

  it('a subject that reappears after erasure gets a fresh key and the old events stay dead', async () => {
    const keyStore = createInMemorySubjectKeyStore();
    const { events, middleware } = makeHarness({ keyStore });

    await middleware(
      makeReq('transfer', { era: 'before' }),
      async () => ({ content: [] }),
      makeCtx(makeIdentity('user-1'), 's-before'),
    );
    await keyStore.destroy('user-1');
    await middleware(
      makeReq('transfer', { era: 'after' }),
      async () => ({ content: [] }),
      makeCtx(makeIdentity('user-1'), 's-after'),
    );

    const current = await keyStore.getOrCreate('user-1');
    // The post-erasure event reads under the new key; the pre-erasure one
    // never will again, under this key or any other.
    expect(decryptInput(asHigh(events[1]), current, 's-after')).toEqual({
      era: 'after',
    });
    expect(() =>
      decryptInput(asHigh(events[0]), current, 's-before'),
    ).toThrow();
  });
});

// ── The marker is covered ────────────────────────────────────────────────────

describe('erasable mode — the marker is covered by the chain', () => {
  it('stripping `erasable` from a recorded event breaks verification at its index', async () => {
    const { events, signingKey, middleware } = makeHarness({
      keyStore: createInMemorySubjectKeyStore(),
    });
    const ctx = makeCtx(makeIdentity('user-1'), 'sess-strip');
    await middleware(
      makeReq('transfer', {}),
      async () => ({ content: [] }),
      ctx,
    );
    await middleware(
      makeReq('transfer', {}),
      async () => ({ content: [] }),
      ctx,
    );

    const { erasable: _dropped, ...stripped } = events[1]!;
    const tampered = [events[0]!, stripped as AuditEvent];

    await expect(verifyAuditChain(tampered, signingKey)).resolves.toEqual({
      valid: false,
      index: 1,
      reason: 'chainHash mismatch',
    });
  });

  it('adding `erasable` to a default-mode event breaks verification at its index', async () => {
    const { events, signingKey, middleware } = makeHarness();
    const ctx = makeCtx(makeIdentity('user-1'), 'sess-add');
    await middleware(
      makeReq('transfer', {}),
      async () => ({ content: [] }),
      ctx,
    );
    await middleware(
      makeReq('transfer', {}),
      async () => ({ content: [] }),
      ctx,
    );

    const tampered = [events[0]!, { ...events[1]!, erasable: true as const }];

    await expect(verifyAuditChain(tampered, signingKey)).resolves.toEqual({
      valid: false,
      index: 1,
      reason: 'chainHash mismatch',
    });
  });
});

// ── Keyed hashes close the confirmation attack ───────────────────────────────

describe('erasable mode — keyed payload hashes', () => {
  it('hashes are HMAC under the subject hash subkey, never the plain sha256', async () => {
    const keyStore = createInMemorySubjectKeyStore();
    const { events, middleware } = makeHarness({ keyStore });
    const args = { acct: 'secret-acct' };

    await middleware(
      makeReq('transfer', args),
      async () => ({ content: [] }),
      makeCtx(makeIdentity('user-1'), 'sess-hash'),
    );
    const event = events[0]!;

    // The confirmation attack: an adversary holding a candidate payload
    // recomputes the plain hash and matches it against the record. In
    // erasable mode that hash is not what the event carries.
    const plain = sha256hex(stableStringify(args));
    expect(event.inputHash).not.toBe(plain);
    expect(event.outputHash).not.toBe(
      sha256hex(stableStringify({ content: [] })),
    );

    // Pins the new domain label: it is part of the on-disk format.
    const hashSubkey = deriveHashSubkey(await keyStore.getOrCreate('user-1'));
    expect(event.inputHash).toBe(
      createHmac('sha256', hashSubkey)
        .update(stableStringify(args))
        .digest('hex'),
    );
    expect(event.inputHash).not.toBe(
      createHmac('sha256', hashSubkey)
        .update(stableStringify({ acct: 'other-acct' }))
        .digest('hex'),
    );
  });

  it('two subjects hash the same payload differently', async () => {
    const { events, middleware } = makeHarness({
      keyStore: createInMemorySubjectKeyStore(),
    });
    const args = { acct: 'same' };

    await middleware(
      makeReq('transfer', args),
      async () => ({ content: [] }),
      makeCtx(makeIdentity('user-1'), 's1'),
    );
    await middleware(
      makeReq('transfer', args),
      async () => ({ content: [] }),
      makeCtx(makeIdentity('user-2'), 's2'),
    );

    expect(events[0]!.inputHash).not.toBe(events[1]!.inputHash);
  });
});

// ── Default mode is untouched ────────────────────────────────────────────────

describe('erasable mode — default mode is byte-identical', () => {
  it('the same call recorded with and without a keyStore differs only in the marker and the hashes', async () => {
    const args = { acct: 'fixed' };
    const result = { content: [{ type: 'text' as const, text: 'fixed-out' }] };
    // ONE context, so requestId, session and identity are literally the same
    // inputs on both runs.
    const ctx = makeCtx(makeIdentity('user-1'), 'sess-identical');

    const plainRun = makeHarness();
    await plainRun.middleware(
      makeReq('transfer', args),
      async () => result,
      ctx,
    );
    const erasableRun = makeHarness({
      keyStore: createInMemorySubjectKeyStore(),
    });
    await erasableRun.middleware(
      makeReq('transfer', args),
      async () => result,
      ctx,
    );

    const plainEvent = plainRun.events[0]!;
    const erasableEvent = erasableRun.events[0]!;

    // Default mode carries no marker and the original plain hashes.
    expect('erasable' in plainEvent).toBe(false);
    expect(plainEvent.inputHash).toBe(sha256hex(stableStringify(args)));
    expect(plainEvent.outputHash).toBe(sha256hex(stableStringify(result)));

    // Everything the chain covers is identical apart from the three fields
    // erasable mode is defined to change, once wall-clock fields are set
    // aside.
    const strip = (event: AuditEvent) => {
      const {
        startedAt: _s,
        endedAt: _e,
        duration_ms: _d,
        inputHash: _i,
        outputHash: _o,
        erasable: _r,
        ...rest
      } = chainPreimageFields(event) as Record<string, unknown> &
        Partial<AuditEvent>;
      return rest;
    };
    expect(strip(erasableEvent)).toEqual(strip(plainEvent));
    expect(erasableEvent.erasable).toBe(true);
  });
});

// ── The store is a pre-call failure ──────────────────────────────────────────

describe('erasable mode — a failing key store', () => {
  it('fails the call before it runs, audits nothing, and stays retryable', async () => {
    let fail = true;
    const inner = createInMemorySubjectKeyStore();
    const keyStore: SubjectKeyStore = {
      getOrCreate: async (subjectId) => {
        if (fail) throw new Error('key store unavailable');
        return inner.getOrCreate(subjectId);
      },
      destroy: (subjectId) => inner.destroy(subjectId),
    };
    const onAuditError = vi.fn();
    const { events, middleware } = makeHarness({ keyStore, onAuditError });
    const next = vi.fn(async () => ({ content: [] }));
    const ctx = makeCtx(makeIdentity('user-1'), 'sess-store-fail');

    await expect(
      middleware(makeReq('transfer', {}), next, ctx),
    ).rejects.toThrow('key store unavailable');

    // No unaudited call, and no audit-error swallowing either: a pre-call
    // failure fails the call, it does not degrade into a recorded event.
    expect(next).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(onAuditError).not.toHaveBeenCalled();

    // Nothing is cached, so a transient outage recovers on the next call.
    fail = false;
    await expect(
      middleware(makeReq('transfer', {}), next, ctx),
    ).resolves.toEqual({ content: [] });
    expect(events).toHaveLength(1);
  });
});

// ── The anonymous bucket ─────────────────────────────────────────────────────

describe('erasable mode — anonymous events', () => {
  it('events with no resolved identity share the anonymous subject bucket', async () => {
    const keyStore = createInMemorySubjectKeyStore();
    const seen: string[] = [];
    const spy: SubjectKeyStore = {
      getOrCreate: (subjectId) => {
        seen.push(subjectId);
        return keyStore.getOrCreate(subjectId);
      },
      destroy: (subjectId) => keyStore.destroy(subjectId),
    };
    const { events, middleware } = makeHarness({ keyStore: spy });

    await middleware(
      makeReq('transfer', { n: 1 }),
      async () => ({ content: [] }),
      makeCtx(undefined, 's-anon'),
    );
    await middleware(
      makeReq('transfer', { n: 2 }),
      async () => ({ content: [] }),
      makeCtx(undefined, 's-anon'),
    );

    expect(seen).toEqual(['anonymous', 'anonymous']);
    // One destroy erases the whole bucket.
    const key = await keyStore.getOrCreate('anonymous');
    expect(decryptInput(asHigh(events[0]), key, 's-anon')).toEqual({ n: 1 });
    await keyStore.destroy('anonymous');
    const fresh = await keyStore.getOrCreate('anonymous');
    expect(() => decryptInput(asHigh(events[0]), fresh, 's-anon')).toThrow();
  });
});

// ── The reference store ──────────────────────────────────────────────────────

describe('createInMemorySubjectKeyStore', () => {
  it('creates a 256-bit key once per subject and returns it stably', async () => {
    const store = createInMemorySubjectKeyStore();
    const first = await store.getOrCreate('a');
    expect(first).toHaveLength(32);
    expect((await store.getOrCreate('a')).equals(first)).toBe(true);
    expect((await store.getOrCreate('b')).equals(first)).toBe(false);
  });

  it('destroying an unknown subject still returns a tombstone', async () => {
    const store = createInMemorySubjectKeyStore();
    const tombstone = await store.destroy('never-seen');
    expect(Number.isNaN(Date.parse(tombstone.destroyedAt))).toBe(false);
  });
});
