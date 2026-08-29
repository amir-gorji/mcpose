import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import { createProxyContext } from 'mcpose';
import type { Identity, ProxyIdentity, RejectionReason } from 'mcpose';
import {
  canonicalJson,
  chainPreimageFields,
  computeChainHash,
  computeMerkleProof,
  computeMerkleRoot,
  sha256hex,
  verifyMerkleProof,
} from '../chain.js';
import { createAuditMiddleware } from '../middleware.js';
import { createSensitivityResolver } from '../sensitivity.js';
import { createDefaultSigningKeyProvider } from '../signingKey.js';
import type { AuditEvent, ReplayManifest } from '../types.js';
import { verifyAuditChain, verifyManifestSignature } from '../verify.js';

// Property-based companions to the example-based tests in chain.test.ts.
// Each block states an invariant from ADR-0004 that must hold for EVERY
// input, not just the hand-picked ones: canonical key ordering, Merkle
// domain separation and proof well-formedness, chain coverage of every
// preimage field, and key derivation.

// The v2 domain labels are part of the on-disk format. Restating them here
// pins them: changing one is a v2 → v3 break and must follow the ritual in
// .claude/skills/mcpose-audit-invariants (new ADR, major bump, new labels).
const LEAF_TAG = 'mcpose/v2/leaf\0';
const NODE_TAG = 'mcpose/v2/node\0';
const DOMAIN_CHAIN = 'mcpose/v2/chain';

// ── Arbitraries ───────────────────────────────────────────────────────────────

const hexHash = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString('hex'));

/** Hex of an arbitrary byte length, including the empty string. */
const anyLengthHex = fc
  .uint8Array({ maxLength: 40 })
  .map((bytes) => Buffer.from(bytes).toString('hex'));

const keyArb = fc.string({ minLength: 1, maxLength: 5 });
const scalarArb = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);
const flatObjectArb = fc.dictionary(keyArb, scalarArb, { maxKeys: 4 });
const nestedObjectArb = fc.dictionary(
  keyArb,
  fc.oneof(
    scalarArb,
    flatObjectArb,
    fc.array(fc.oneof(scalarArb, flatObjectArb), { maxLength: 3 }),
  ),
  { maxKeys: 4 },
);

const isoArb = fc
  .integer({ min: 0, max: 4_000_000_000_000 })
  .map((ms) => new Date(ms).toISOString());

const identityArb: fc.Arbitrary<Identity> = fc.record(
  {
    sub: fc.string({ minLength: 1, maxLength: 10 }),
    type: fc.constantFrom('human', 'agent', 'service'),
    displayName: fc.string({ maxLength: 8 }),
    roles: fc.array(fc.string({ maxLength: 6 }), { maxLength: 3 }),
    claims: fc.dictionary(keyArb, scalarArb, { maxKeys: 3 }),
    resolvedAt: isoArb,
    source: fc.constantFrom('jwt', 'mtls', 'apikey', 'custom'),
  },
  {
    requiredKeys: ['sub', 'type', 'roles', 'claims', 'resolvedAt', 'source'],
  },
);

const proxyArb: fc.Arbitrary<ProxyIdentity> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 10 }),
  version: fc.string({ minLength: 1, maxLength: 8 }),
});

/**
 * Every field the chain preimage covers (ADR-0004), minus
 * `replayManifestPosition`, which the verifier checks separately, and the
 * optional `kind`, covered by the middleware tests. `proxy` is required and
 * always covered (ADR-0019), so it is generated and tampered like any other
 * always-present field.
 */
interface PreimageFields {
  id: string;
  startedAt: string;
  endedAt: string;
  sessionId?: string | undefined;
  delegatedFrom?: Identity[] | undefined;
  proxy: ProxyIdentity;
  identity: Identity;
  tool: string;
  duration_ms: number;
  outcome: AuditEvent['outcome'];
  sensitivityTier: AuditEvent['sensitivityTier'];
  rejectionReason?: RejectionReason | undefined;
  error?: { name: string; message: string } | undefined;
  inputHash: string;
  outputHash: string;
}

const PREIMAGE_FIELDS = [
  'id',
  'startedAt',
  'endedAt',
  'sessionId',
  'delegatedFrom',
  'proxy',
  'identity',
  'tool',
  'duration_ms',
  'outcome',
  'sensitivityTier',
  'rejectionReason',
  'error',
  'inputHash',
  'outputHash',
] as const satisfies readonly (keyof PreimageFields)[];

const eventFieldsArb: fc.Arbitrary<PreimageFields> = fc.record(
  {
    id: fc.string({ minLength: 1, maxLength: 12 }),
    startedAt: isoArb,
    endedAt: isoArb,
    sessionId: fc.string({ minLength: 1, maxLength: 8 }),
    delegatedFrom: fc.array(identityArb, { minLength: 1, maxLength: 2 }),
    proxy: proxyArb,
    identity: identityArb,
    tool: fc.string({ minLength: 1, maxLength: 10 }),
    duration_ms: fc.nat({ max: 100_000 }),
    outcome: fc.constantFrom('success', 'rejected', 'error'),
    sensitivityTier: fc.constantFrom('low', 'medium', 'high'),
    rejectionReason: fc.constantFrom<RejectionReason[]>(
      'TOOL_HIDDEN',
      'POLICY_DENIED',
      'BUDGET_EXCEEDED',
    ),
    error: fc.record({
      name: fc.string({ maxLength: 8 }),
      message: fc.string({ maxLength: 20 }),
    }),
    inputHash: hexHash,
    outputHash: hexHash,
  },
  {
    requiredKeys: [
      'id',
      'startedAt',
      'endedAt',
      'proxy',
      'identity',
      'tool',
      'duration_ms',
      'outcome',
      'sensitivityTier',
      'inputHash',
      'outputHash',
    ],
  },
);

const chainFieldsArb = fc.array(eventFieldsArb, {
  minLength: 1,
  maxLength: 5,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET = 'property-test-secret';
const signingKey = createDefaultSigningKeyProvider(SECRET);
let chainKey: Buffer;

const baseIdentity: Identity = {
  sub: 'user-1',
  type: 'human',
  roles: ['analyst'],
  claims: {},
  resolvedAt: '2026-06-01T00:00:00.000Z',
  source: 'jwt',
};

/**
 * Builds an honest chain straight from the primitives, so the generated
 * events can carry field values the middleware would never produce.
 * `fc.record(..., { requiredKeys })` omits the optional keys rather than
 * setting them to `undefined`, so the casts only restate at the type level
 * what is already true at run time under `exactOptionalPropertyTypes`.
 */
function buildChain(fields: readonly PreimageFields[]): AuditEvent[] {
  const events: AuditEvent[] = [];
  let prevChainHash = '';
  fields.forEach((f, i) => {
    const withoutChainHash = {
      ...f,
      replayManifestPosition: i,
      ...(f.sensitivityTier === 'high'
        ? { inputEncrypted: '', outputEncrypted: '' }
        : { inputRaw: {}, outputRaw: null }),
    } as Omit<AuditEvent, 'chainHash'>;
    const chainHash = computeChainHash(
      chainPreimageFields(withoutChainHash),
      prevChainHash,
      chainKey,
    );
    events.push({ ...withoutChainHash, chainHash } as AuditEvent);
    prevChainHash = chainHash;
  });
  return events;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rebuilds a value with every object's keys inserted in a random order. */
function reinsertShuffled(value: unknown, rnd: () => number): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => reinsertShuffled(item, rnd));
  }
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [entries[i], entries[j]] = [entries[j]!, entries[i]!];
  }
  return Object.fromEntries(
    entries.map(([k, v]) => [k, reinsertShuffled(v, rnd)]),
  );
}

function flipHexBit(hex: string, bit: number): string {
  const pos = Math.floor(bit / 4) % hex.length;
  const flipped = (parseInt(hex[pos]!, 16) ^ (1 << (bit % 4))).toString(16);
  return hex.slice(0, pos) + flipped + hex.slice(pos + 1);
}

async function runSession(opts: {
  sessionId: string | undefined;
  delegatedFrom: Identity[] | undefined;
  count: number;
}): Promise<{ events: AuditEvent[]; manifest: ReplayManifest | undefined }> {
  const events: AuditEvent[] = [];
  const { middleware, closeSession } = createAuditMiddleware({
    signingKey,
    sensitivityResolver: createSensitivityResolver({ search: 'low' }),
    onEvent: (e) => {
      events.push(e);
    },
  });
  for (let i = 0; i < opts.count; i++) {
    await middleware(
      {
        method: 'tools/call' as const,
        params: { name: 'search', arguments: { i } },
      },
      async () => ({ content: [] }),
      createProxyContext({
        transport: 'http',
        identity: baseIdentity,
        sessionId: opts.sessionId,
        delegatedFrom: opts.delegatedFrom,
        proxy: { name: 'test-proxy', version: '0.0.0' },
      }),
    );
  }
  const manifest =
    opts.sessionId === undefined
      ? undefined
      : await closeSession(opts.sessionId);
  return { events, manifest };
}

beforeAll(async () => {
  chainKey = await signingKey.sign(Buffer.from(DOMAIN_CHAIN));
});

// ── Canonical serialization ───────────────────────────────────────────────────

describe('canonicalJson (properties)', () => {
  it('is invariant under key insertion order at every depth', () => {
    fc.assert(
      fc.property(nestedObjectArb, fc.integer(), (obj, seed) => {
        const shuffled = reinsertShuffled(obj, mulberry32(seed));
        expect(canonicalJson(shuffled)).toBe(canonicalJson(obj));
      }),
    );
  });

  it('orders distinct keys by a strict total order, collapsing none', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), {
          minLength: 1,
          maxLength: 12,
        }),
        (keys) => {
          const obj = Object.fromEntries(keys.map((k, i) => [k, i]));
          // Reference serialization: every key present exactly once, in
          // ascending code-unit order — the order `<` induces.
          const expected = `{${[...keys]
            .sort()
            .map((k) => `${JSON.stringify(k)}:${keys.indexOf(k)}`)
            .join(',')}}`;
          expect(canonicalJson(obj)).toBe(expected);
        },
      ),
    );
  });

  it('treats an undefined-valued key as an absent key', () => {
    fc.assert(
      fc.property(
        nestedObjectArb,
        fc.uniqueArray(keyArb, { maxLength: 4 }),
        (obj, extraKeys) => {
          const withUndefined: Record<string, unknown> = { ...obj };
          for (const k of extraKeys) {
            if (!Object.hasOwn(obj, k)) withUndefined[k] = undefined;
          }
          expect(canonicalJson(withUndefined)).toBe(canonicalJson(obj));
        },
      ),
    );
  });
});

// ── Merkle tree ───────────────────────────────────────────────────────────────

describe('Merkle tree (properties)', () => {
  const leavesArb = fc.uniqueArray(hexHash, { minLength: 1, maxLength: 12 });
  const multiLeavesArb = fc.uniqueArray(hexHash, {
    minLength: 2,
    maxLength: 8,
  });

  it('pins the v2 leaf and node tags', () => {
    fc.assert(
      fc.property(hexHash, hexHash, (a, b) => {
        const leafA = sha256hex(LEAF_TAG + a);
        const leafB = sha256hex(LEAF_TAG + b);
        expect(computeMerkleRoot([a])).toBe(leafA);
        expect(computeMerkleRoot([a, b])).toBe(
          sha256hex(NODE_TAG + leafA + leafB),
        );
      }),
    );
  });

  it('roots an empty tree at sha256 of the empty string', () => {
    expect(computeMerkleRoot([])).toBe(sha256hex(''));
  });

  it('round-trips a proof for every leaf of every tree size', () => {
    fc.assert(
      fc.property(leavesArb, (leaves) => {
        const root = computeMerkleRoot(leaves);
        leaves.forEach((leaf, i) => {
          expect(
            verifyMerkleProof(leaf, computeMerkleProof(leaves, i), root),
          ).toBe(true);
        });
      }),
    );
  });

  it('never verifies a proof against another leaf or an internal node', () => {
    fc.assert(
      fc.property(multiLeavesArb, (leaves) => {
        const root = computeMerkleRoot(leaves);
        leaves.forEach((_, i) => {
          const proof = computeMerkleProof(leaves, i);
          leaves.forEach((other, j) => {
            if (i !== j)
              expect(verifyMerkleProof(other, proof, root)).toBe(false);
          });
          // Siblings above level 0 are internal node hashes. Domain
          // separation is what stops one being replayed as a leaf.
          proof.siblings.slice(1).forEach((internal) => {
            expect(verifyMerkleProof(internal, proof, root)).toBe(false);
          });
        });
      }),
    );
  });

  it('never hashes an internal node preimage to a valid leaf', () => {
    fc.assert(
      fc.property(hexHash, hexHash, (a, b) => {
        fc.pre(a !== b);
        // A leaf whose value IS the internal node's untagged preimage.
        // Without the leaf/node tags it would hash to that node and could
        // be replayed at any level of the tree.
        const forged =
          NODE_TAG + computeMerkleRoot([a]) + computeMerkleRoot([b]);
        expect(computeMerkleRoot([forged])).not.toBe(computeMerkleRoot([a, b]));
      }),
    );
  });
});

describe('verifyMerkleProof rejects malformed proofs (properties)', () => {
  const multiLeavesArb = fc.uniqueArray(hexHash, {
    minLength: 2,
    maxLength: 8,
  });

  it('rejects a length disagreement between siblings and directions', () => {
    fc.assert(
      fc.property(multiLeavesArb, fc.nat(), (leaves, raw) => {
        const root = computeMerkleRoot(leaves);
        const i = raw % leaves.length;
        const proof = computeMerkleProof(leaves, i);
        // An extra direction leaves the sibling walk intact, so without the
        // length check this proof would still land on the root.
        expect(
          verifyMerkleProof(
            leaves[i]!,
            { ...proof, directions: [...proof.directions, 'right'] },
            root,
          ),
        ).toBe(false);
        expect(
          verifyMerkleProof(
            leaves[i]!,
            {
              ...proof,
              siblings: [...proof.siblings, proof.siblings[0] ?? ''],
            },
            root,
          ),
        ).toBe(false);
      }),
    );
  });

  it('rejects a non-integer index that would otherwise verify', () => {
    fc.assert(
      fc.property(multiLeavesArb, fc.nat(), (leaves, raw) => {
        const odd = leaves.map((_, k) => k).filter((k) => k % 2 === 1);
        const i = odd[raw % odd.length]!;
        const root = computeMerkleRoot(leaves);
        const proof = computeMerkleProof(leaves, i);
        // For an odd index, `index + 0.5` derives the identical direction
        // sequence at every level, so only the integer check rejects it.
        expect(
          verifyMerkleProof(leaves[i]!, { ...proof, index: i + 0.5 }, root),
        ).toBe(false);
      }),
    );
  });

  it('rejects a negative index that would otherwise verify', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(hexHash, { minLength: 16, maxLength: 16 }),
        fc.integer({ min: 1, max: 4 }),
        (pool, depth) => {
          // A perfect tree's last index is all-ones, so every level's
          // direction is 'left' — exactly what index -1 derives.
          const leaves = pool.slice(0, 2 ** depth);
          const i = leaves.length - 1;
          const root = computeMerkleRoot(leaves);
          const proof = computeMerkleProof(leaves, i);
          expect(proof.directions.every((d) => d === 'left')).toBe(true);
          expect(
            verifyMerkleProof(leaves[i]!, { ...proof, index: -1 }, root),
          ).toBe(false);
        },
      ),
    );
  });

  it('rejects a hole in siblings rather than coercing it to a string', () => {
    fc.assert(
      fc.property(hexHash, (leaf) => {
        const sparse: string[] = [];
        sparse.length = 1;
        // A root crafted from the coerced hole: the proof must be rejected
        // for being malformed, not walked with `undefined` as a sibling.
        const coercedRoot = sha256hex(
          NODE_TAG + sha256hex(LEAF_TAG + leaf) + 'undefined',
        );
        expect(
          verifyMerkleProof(
            leaf,
            { index: 0, siblings: sparse, directions: ['right'] },
            coercedRoot,
          ),
        ).toBe(false);
      }),
    );
  });
});

// ── Keyed chain verification ──────────────────────────────────────────────────

describe('verifyAuditChain (properties)', () => {
  it('accepts every honestly built chain', async () => {
    await fc.assert(
      fc.asyncProperty(chainFieldsArb, async (fields) => {
        expect(await verifyAuditChain(buildChain(fields), signingKey)).toEqual({
          valid: true,
        });
      }),
    );
  });

  it('detects a change to any preimage field, at that exact index', async () => {
    await fc.assert(
      fc.asyncProperty(
        chainFieldsArb,
        eventFieldsArb,
        fc.nat(),
        async (fields, donor, raw) => {
          const i = raw % fields.length;
          const honest = buildChain(fields);
          for (const field of PREIMAGE_FIELDS) {
            const target = fields[i]!;
            // Canonical equality is the only equality the chain sees: a
            // donor value that serializes identically is not a tamper.
            if (
              canonicalJson(target[field] ?? null) ===
              canonicalJson(donor[field] ?? null)
            ) {
              continue;
            }
            const tampered = { ...honest[i]! } as Record<string, unknown>;
            if (Object.hasOwn(donor, field)) tampered[field] = donor[field];
            else delete tampered[field];
            const events = honest.map((e, k) =>
              k === i ? (tampered as unknown as AuditEvent) : e,
            );
            expect(await verifyAuditChain(events, signingKey)).toEqual({
              valid: false,
              index: i,
              reason: 'chainHash mismatch',
            });
          }
        },
      ),
    );
  });

  it('detects a single-bit flip of a hashed payload digest', async () => {
    await fc.assert(
      fc.asyncProperty(
        chainFieldsArb,
        fc.nat(),
        fc.nat({ max: 255 }),
        fc.constantFrom('inputHash', 'outputHash'),
        async (fields, raw, bit, field) => {
          const i = raw % fields.length;
          const honest = buildChain(fields);
          const events = honest.map((e, k) =>
            k === i ? { ...e, [field]: flipHexBit(e[field], bit) } : e,
          );
          expect(await verifyAuditChain(events, signingKey)).toEqual({
            valid: false,
            index: i,
            reason: 'chainHash mismatch',
          });
        },
      ),
    );
  });

  it('rejects a corrupted chainHash of any length without throwing', async () => {
    await fc.assert(
      fc.asyncProperty(
        chainFieldsArb,
        fc.nat(),
        anyLengthHex,
        async (fields, raw, corrupt) => {
          const honest = buildChain(fields);
          const i = raw % honest.length;
          fc.pre(corrupt !== honest[i]!.chainHash);
          const events = honest.map((e, k) =>
            k === i ? { ...e, chainHash: corrupt } : e,
          );
          // A shorter, longer, or empty hash must compare unequal, not
          // throw out of the timing-safe comparison.
          expect(await verifyAuditChain(events, signingKey)).toEqual({
            valid: false,
            index: i,
            reason: 'chainHash mismatch',
          });
        },
      ),
    );
  });

  it('reports a replayManifestPosition mismatch at the offending index', async () => {
    await fc.assert(
      fc.asyncProperty(
        chainFieldsArb,
        fc.nat(),
        fc.integer({ min: -3, max: 20 }),
        async (fields, raw, position) => {
          const honest = buildChain(fields);
          const i = raw % honest.length;
          fc.pre(position !== i);
          const events = honest.map((e, k) =>
            k === i ? { ...e, replayManifestPosition: position } : e,
          );
          expect(await verifyAuditChain(events, signingKey)).toEqual({
            valid: false,
            index: i,
            reason: `replayManifestPosition ${position}, expected ${i}`,
          });
        },
      ),
    );
  });
});

// ── Optional context fields end to end ────────────────────────────────────────

describe('optional event fields (properties)', () => {
  it('round-trips sessionId and delegatedFrom presence through verification', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.option(fc.array(identityArb, { minLength: 1, maxLength: 2 }), {
          nil: undefined,
        }),
        fc.integer({ min: 1, max: 3 }),
        async (withSession, delegatedFrom, count) => {
          // Without a sessionId there is no session state, so every event
          // is a standalone position-0 entry (intentional — see the skill).
          const sessionId = withSession ? 'p-session' : undefined;
          const { events, manifest } = await runSession({
            sessionId,
            delegatedFrom,
            count: withSession ? count : 1,
          });
          for (const event of events) {
            expect(Object.hasOwn(event, 'sessionId')).toBe(withSession);
            expect(Object.hasOwn(event, 'delegatedFrom')).toBe(
              delegatedFrom !== undefined,
            );
            expect(event.delegatedFrom).toEqual(delegatedFrom);
          }
          expect(await verifyAuditChain(events, signingKey)).toEqual({
            valid: true,
          });
          expect(manifest?.eventCount).toBe(withSession ? count : undefined);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('verifyManifestSignature (properties)', () => {
  let manifest: ReplayManifest;

  beforeAll(async () => {
    const session = await runSession({
      sessionId: 'm-props',
      delegatedFrom: undefined,
      count: 3,
    });
    manifest = session.manifest!;
  });

  it('rejects a signature of any length without throwing', async () => {
    await fc.assert(
      fc.asyncProperty(anyLengthHex, async (signature) => {
        fc.pre(signature !== manifest.signature);
        expect(
          await verifyManifestSignature({ ...manifest, signature }, signingKey),
        ).toBe(false);
      }),
    );
  });
});

// ── Signing key derivation ────────────────────────────────────────────────────

describe('createDefaultSigningKeyProvider (properties)', () => {
  const secretArb = fc.string({ minLength: 1, maxLength: 40 });

  it('derives the same keyId and signatures from a string and its bytes', async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        fc.uint8Array({ minLength: 1, maxLength: 32 }),
        async (secret, data) => {
          const fromString = createDefaultSigningKeyProvider(secret);
          const fromBuffer = createDefaultSigningKeyProvider(
            Buffer.from(secret),
          );
          expect(fromBuffer.keyId).toBe(fromString.keyId);
          const message = Buffer.from(data);
          expect((await fromBuffer.sign(message)).toString('hex')).toBe(
            (await fromString.sign(message)).toString('hex'),
          );
        },
      ),
    );
  });

  it('derives different keys from different secrets', async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        secretArb,
        fc.uint8Array({ minLength: 1, maxLength: 32 }),
        async (a, b, data) => {
          fc.pre(!Buffer.from(a).equals(Buffer.from(b)));
          const first = createDefaultSigningKeyProvider(a);
          const second = createDefaultSigningKeyProvider(b);
          expect(first.keyId).not.toBe(second.keyId);
          const message = Buffer.from(data);
          expect((await first.sign(message)).toString('hex')).not.toBe(
            (await second.sign(message)).toString('hex'),
          );
        },
      ),
    );
  });
});
