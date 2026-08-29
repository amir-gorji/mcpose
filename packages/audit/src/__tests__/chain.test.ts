import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  canonicalJson,
  stableStringify,
  computeMerkleRoot,
  computeMerkleProof,
  verifyMerkleProof,
  sha256hex,
} from '../chain.js';
import { verifyAuditChain, verifyManifestSignature } from '../verify.js';
import { createAuditMiddleware } from '../middleware.js';
import { createDefaultSigningKeyProvider } from '../signingKey.js';
import { createSensitivityResolver } from '../sensitivity.js';
import { createInMemorySubjectKeyStore } from '../subjectKeyStore.js';
import type { AuditEvent } from '../types.js';
import { createProxyContext } from 'mcpose';
import type { Identity } from 'mcpose';

const identity: Identity = {
  sub: 'user-1',
  type: 'human',
  roles: ['analyst'],
  claims: {},
  resolvedAt: '2026-06-01T00:00:00.000Z',
  source: 'jwt',
};

describe('canonicalJson', () => {
  it('is independent of object key insertion order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('skips undefined-valued keys and keeps array order', () => {
    expect(canonicalJson({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });

  it('throws on circular references and BigInt', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(TypeError);
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
  });
});

describe('stableStringify', () => {
  it('never throws: circular becomes "[Circular]", BigInt becomes a string', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(stableStringify(circular)).toBe('{"a":1,"self":"[Circular]"}');
    expect(stableStringify({ n: 123n })).toBe('{"n":"123"}');
  });

  it('hashes semantically identical payloads identically regardless of key order', () => {
    expect(sha256hex(stableStringify({ x: 1, y: 2 }))).toBe(
      sha256hex(stableStringify({ y: 2, x: 1 })),
    );
  });
});

describe('Merkle tree (v2, domain-separated)', () => {
  const leaves = ['aa', 'bb', 'cc'];

  it('every proof verifies against the root', () => {
    const root = computeMerkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const proof = computeMerkleProof(leaves, i);
      expect(verifyMerkleProof(leaves[i]!, proof, root)).toBe(true);
    }
  });

  it('single leaf root is the tagged leaf hash, not the raw value', () => {
    const root = computeMerkleRoot(['aa']);
    expect(root).not.toBe('aa');
    expect(
      verifyMerkleProof('aa', { index: 0, siblings: [], directions: [] }, root),
    ).toBe(true);
  });

  it('an internal node cannot be replayed as a leaf', () => {
    const root = computeMerkleRoot(leaves);
    const proof = computeMerkleProof(leaves, 0);
    // Try to verify the level-1 sibling (an internal node in disguise)
    // as if it were a leaf under a shortened proof.
    const forged = {
      index: 1,
      siblings: proof.siblings.slice(1),
      directions: proof.directions.slice(1),
    };
    expect(verifyMerkleProof(proof.siblings[0]!, forged, root)).toBe(false);
  });

  it('computeMerkleProof bounds-checks the index', () => {
    expect(() => computeMerkleProof(leaves, -1)).toThrow(RangeError);
    expect(() => computeMerkleProof(leaves, 3)).toThrow(RangeError);
    expect(() => computeMerkleProof(leaves, 1.5)).toThrow(RangeError);
  });

  it('rejects proofs with mismatched siblings/directions lengths', () => {
    const root = computeMerkleRoot(leaves);
    const proof = computeMerkleProof(leaves, 0);
    expect(
      verifyMerkleProof(
        leaves[0]!,
        { ...proof, directions: proof.directions.slice(1) },
        root,
      ),
    ).toBe(false);
  });

  it('rejects proofs whose directions contradict the index', () => {
    const root = computeMerkleRoot(leaves);
    const proof = computeMerkleProof(leaves, 0);
    const flipped = {
      ...proof,
      directions: proof.directions.map((d) =>
        d === 'left' ? 'right' : 'left',
      ),
    };
    expect(verifyMerkleProof(leaves[0]!, flipped, root)).toBe(false);
  });
});

// ── Keyed verification end-to-end ─────────────────────────────────────────────

async function produceSession(sessionId: string, count: number) {
  const events: AuditEvent[] = [];
  const signingKey = createDefaultSigningKeyProvider('test-secret');
  const { middleware, closeSession } = createAuditMiddleware({
    signingKey,
    sensitivityResolver: createSensitivityResolver({ search: 'low' }),
    onEvent: (e) => {
      events.push(e);
    },
  });
  // `proxy` is a required covered field, and the middleware rejects a context
  // without one before the call runs (ADR-0019).
  const ctx = () =>
    createProxyContext({
      transport: 'http',
      identity,
      sessionId,
      proxy: { name: 'test-proxy', version: '0.0.0' },
    });
  for (let i = 0; i < count; i++) {
    await middleware(
      {
        method: 'tools/call' as const,
        params: { name: 'search', arguments: { i } },
      },
      async () => ({ content: [] }),
      ctx(),
    );
  }
  const manifest = await closeSession(sessionId);
  return { events, manifest: manifest!, signingKey };
}

describe('verifyAuditChain (keyed)', () => {
  it('verifies an untampered chain', async () => {
    const { events, signingKey } = await produceSession('s-ok', 4);
    expect(await verifyAuditChain(events, signingKey)).toEqual({ valid: true });
  });

  it('rejects an empty chain', async () => {
    const signingKey = createDefaultSigningKeyProvider('test-secret');
    const result = await verifyAuditChain([], signingKey);
    expect(result.valid).toBe(false);
  });

  it('reports the exact index of a tampered field', async () => {
    const { events, signingKey } = await produceSession('s-tamper', 4);
    const tampered = events.map((e, i) =>
      i === 2 ? { ...e, duration_ms: e.duration_ms + 1 } : e,
    );
    const result = await verifyAuditChain(tampered, signingKey);
    expect(result).toEqual({
      valid: false,
      index: 2,
      reason: 'chainHash mismatch',
    });
  });

  it('detects a renumbered suffix (delete + renumber)', async () => {
    const { events, signingKey } = await produceSession('s-renumber', 4);
    // Delete event 1 and renumber the survivors — the keyless position
    // check would pass; the keyed recompute must not.
    const doctored = [events[0]!, ...events.slice(2)].map((e, i) => ({
      ...e,
      replayManifestPosition: i,
    }));
    const result = await verifyAuditChain(doctored, signingKey);
    expect(result.valid).toBe(false);
  });

  it('rejects a chain produced under a different secret', async () => {
    const { events } = await produceSession('s-wrongkey', 2);
    const otherKey = createDefaultSigningKeyProvider('other-secret');
    const result = await verifyAuditChain(events, otherKey);
    expect(result.valid).toBe(false);
  });
});

describe('sensitivityTier is covered by the chain (ADR-0015)', () => {
  /** Index 0 is a mapped low tool; index 1 is unmapped, so it fails closed to high. */
  async function produceMixedSession(sessionId: string) {
    const events: AuditEvent[] = [];
    const signingKey = createDefaultSigningKeyProvider('test-secret');
    const { middleware } = createAuditMiddleware({
      signingKey,
      sensitivityResolver: createSensitivityResolver({ search: 'low' }),
      onEvent: (e) => {
        events.push(e);
      },
    });
    for (const name of ['search', 'wire-transfer']) {
      await middleware(
        { method: 'tools/call' as const, params: { name, arguments: {} } },
        async () => ({ content: [] }),
        createProxyContext({
          transport: 'http',
          identity,
          sessionId,
          proxy: { name: 'test-proxy', version: '0.0.0' },
        }),
      );
    }
    return { events, signingKey };
  }

  it('records the resolved tier and still verifies untampered', async () => {
    const { events, signingKey } = await produceMixedSession('s-tier-ok');
    expect(events.map((e) => e.sensitivityTier)).toEqual(['low', 'high']);
    expect(await verifyAuditChain(events, signingKey)).toEqual({ valid: true });
  });

  it.each([
    ['a high event relabelled as low', 1, 'low'],
    ['a low event relabelled as high', 0, 'high'],
  ] as const)('detects %s at exactly that index', async (_case, i, tier) => {
    const { events, signingKey } = await produceMixedSession('s-tier-tamper');
    const tampered = events.map((e, k) =>
      k === i ? ({ ...e, sensitivityTier: tier } as AuditEvent) : e,
    );
    expect(await verifyAuditChain(tampered, signingKey)).toEqual({
      valid: false,
      index: i,
      reason: 'chainHash mismatch',
    });
  });

  it('detects a tier dropped from a stored event entirely', async () => {
    const { events, signingKey } = await produceMixedSession('s-tier-drop');
    const stripped = events.map((e, k) => {
      if (k !== 0) return e;
      const { sensitivityTier: _dropped, ...rest } = e;
      return rest as unknown as AuditEvent;
    });
    expect(await verifyAuditChain(stripped, signingKey)).toEqual({
      valid: false,
      index: 0,
      reason: 'chainHash mismatch',
    });
  });
});

describe('verifyManifestSignature', () => {
  it('verifies an untampered manifest', async () => {
    const { manifest, signingKey } = await produceSession('m-ok', 3);
    expect(await verifyManifestSignature(manifest, signingKey)).toBe(true);
  });

  it.each([
    ['sessionId', { sessionId: 'someone-elses-session' }],
    ['eventCount', { eventCount: 4 }],
    ['identity', { identity: { ...identity, sub: 'attacker' } }],
    ['merkleRoot', { merkleRoot: sha256hex('forged') }],
  ])('rejects a manifest with a tampered %s', async (_field, patch) => {
    const { manifest, signingKey } = await produceSession('m-tamper', 3);
    const tampered = { ...manifest, ...patch };
    expect(await verifyManifestSignature(tampered, signingKey)).toBe(false);
  });

  it('rejects a signature from a different secret', async () => {
    const { manifest } = await produceSession('m-wrongkey', 3);
    const otherKey = createDefaultSigningKeyProvider('other-secret');
    expect(await verifyManifestSignature(manifest, otherKey)).toBe(false);
  });
});

describe('domain label pinning', () => {
  // The exact label strings are part of the on-disk format. Changing any of
  // them is a v2 → v3 format break and must follow the ritual in
  // .claude/skills/mcpose-audit-invariants (new ADR, version bump, new labels).
  it('derives subkeys with the pinned v2 labels', async () => {
    const seen: string[] = [];
    const provider = createDefaultSigningKeyProvider('test-secret');
    const spy = vi.fn(async (data: Buffer) => {
      seen.push(data.toString('utf8'));
      return provider.sign(data);
    });
    const { middleware } = createAuditMiddleware({
      signingKey: { ...provider, sign: spy },
      sensitivityResolver: createSensitivityResolver({}),
      onEvent: () => {},
    });
    await middleware(
      { method: 'tools/call' as const, params: { name: 't', arguments: {} } },
      async () => ({ content: [] }),
      createProxyContext({
        transport: 'http',
        identity,
        proxy: { name: 'test-proxy', version: '0.0.0' },
      }),
    );
    expect(seen).toContain('mcpose/v2/chain');
    expect(seen).toContain('mcpose/v2/enc');
    expect(seen).not.toContain('mcpose/v1/chain');
    expect(seen).not.toContain('mcpose/v1/enc');
  });

  // The erasable-mode hash subkey is keyed by the STORED subject key, not by
  // the signing oracle, so it never passes through the sign() spy above. Its
  // label is pinned by recomputing a recorded hash under the literal string
  // (ADR-0018).
  it('derives the erasable-mode hash subkey with the pinned v2 label', async () => {
    const events: AuditEvent[] = [];
    const keyStore = createInMemorySubjectKeyStore();
    const { middleware } = createAuditMiddleware({
      signingKey: createDefaultSigningKeyProvider('test-secret'),
      sensitivityResolver: createSensitivityResolver({}),
      keyStore,
      onEvent: (e) => {
        events.push(e);
      },
    });
    const args = { acct: 'pinned' };
    await middleware(
      { method: 'tools/call' as const, params: { name: 't', arguments: args } },
      async () => ({ content: [] }),
      createProxyContext({
        transport: 'http',
        identity,
        proxy: { name: 'test-proxy', version: '0.0.0' },
      }),
    );

    const subjectKey = await keyStore.getOrCreate(identity.sub);
    const underPinnedLabel = createHmac(
      'sha256',
      createHmac('sha256', subjectKey).update('mcpose/v2/hashkey').digest(),
    )
      .update(stableStringify(args))
      .digest('hex');
    expect(events[0]!.inputHash).toBe(underPinnedLabel);
  });
});
