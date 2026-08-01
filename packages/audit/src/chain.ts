import { createHash, createHmac } from 'node:crypto';
import type { AuditEvent, MerkleProof } from './types.js';

// ── Canonical serialization ────────────────────────────────────────────────────
//
// v1 hashed `JSON.stringify` output, which made object-key insertion order
// load-bearing: an independently written verifier that reconstructed the
// fields in a different order failed on every chainHash. v2 hashes a
// canonical form instead — lexicographically sorted keys at every depth —
// so only the field SET matters. See ADR-0004.

/**
 * Canonical JSON: object keys sorted lexicographically at every depth,
 * `undefined`-valued keys skipped. Throws on values with no canonical JSON
 * form (BigInt, function, symbol, circular references).
 *
 * Use for data the audit layer controls (chain preimages, manifest
 * payloads). For arbitrary caller payloads use {@link stableStringify}.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set(), { strict: true });
}

/**
 * Total variant of {@link canonicalJson} for arbitrary caller payloads:
 * never throws. Circular references become `"[Circular]"`, BigInt becomes
 * its decimal string. Used for `inputHash`/`outputHash`, so two
 * semantically identical payloads hash identically regardless of the
 * client's JSON key order.
 */
export function stableStringify(value: unknown): string {
  return serialize(value, new Set(), { strict: false });
}

function serialize(
  value: unknown,
  seen: Set<object>,
  opts: { strict: boolean },
): string {
  if (value === null || value === undefined) return 'null';

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value);
    case 'bigint':
      if (opts.strict) {
        throw new TypeError('canonicalJson: BigInt has no canonical JSON form');
      }
      return JSON.stringify(value.toString());
    case 'function':
    case 'symbol':
      if (opts.strict) {
        throw new TypeError(
          `canonicalJson: ${typeof value} has no canonical JSON form`,
        );
      }
      return 'null';
  }

  const obj = value as object;
  if (seen.has(obj)) {
    if (opts.strict) {
      throw new TypeError('canonicalJson: circular reference');
    }
    return '"[Circular]"';
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => serialize(item, seen, opts)).join(',')}]`;
    }
    if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
      return serialize(
        (obj as { toJSON: () => unknown }).toJSON(),
        seen,
        opts,
      );
    }
    const entries = Object.entries(obj)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, seen, opts)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

// ── Hash primitives ────────────────────────────────────────────────────────────

export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256hex(data: string | Buffer, key: Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

// ── HMAC chain ─────────────────────────────────────────────────────────────────

const DOMAIN_CHAIN_HASH = 'mcpose/v2/chain';

/**
 * The exact fields of an audit event that the chain covers, extracted from
 * the event. Used by both the producer (middleware) and any verifier
 * ({@link verifyAuditChain}) so the two cannot drift.
 *
 * NOT covered (bound only via inputHash/outputHash, or not at all):
 * `sensitivityTier` and the raw/encrypted payloads.
 */
export function chainPreimageFields(
  event: Omit<AuditEvent, 'chainHash'> | AuditEvent,
): Record<string, unknown> {
  return {
    id: event.id,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.delegatedFrom === undefined
      ? {}
      : { delegatedFrom: event.delegatedFrom }),
    identity: event.identity,
    tool: event.tool,
    duration_ms: event.duration_ms,
    outcome: event.outcome,
    ...(event.rejectionReason === undefined
      ? {}
      : { rejectionReason: event.rejectionReason }),
    ...(event.error === undefined ? {} : { error: event.error }),
    inputHash: event.inputHash,
    outputHash: event.outputHash,
    replayManifestPosition: event.replayManifestPosition,
  };
}

/**
 * `HMAC-SHA256(chainKey, canonicalJson({domain, prevChainHash, event}))`.
 * Domain-separated and canonically framed: neither field order nor
 * string-concatenation ambiguity can affect the hash. The entry is
 * serialized without its own chainHash. First entry uses `prevChainHash: ''`.
 */
export function computeChainHash(
  entryWithoutChainHash: Record<string, unknown>,
  prevChainHash: string,
  chainKey: Buffer,
): string {
  const preimage = canonicalJson({
    domain: DOMAIN_CHAIN_HASH,
    prevChainHash,
    event: entryWithoutChainHash,
  });
  return hmacSha256hex(preimage, chainKey);
}

// ── Merkle tree ────────────────────────────────────────────────────────────────
//
// Leaves and internal nodes are domain-separated so an internal node can
// never be replayed as a leaf (second-preimage hardening). Odd layers
// duplicate the last node; ambiguity from that padding is neutralized by
// the signed `eventCount` in the manifest payload.

const LEAF_TAG = 'mcpose/v2/leaf\0';
const NODE_TAG = 'mcpose/v2/node\0';

function leafHash(chainHash: string): string {
  return sha256hex(LEAF_TAG + chainHash);
}

function nodeHash(left: string, right: string): string {
  return sha256hex(NODE_TAG + left + right);
}

function nextLayer(layer: string[]): string[] {
  const padded =
    layer.length % 2 === 1 ? [...layer, layer[layer.length - 1]] : layer;
  const next: string[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    next.push(nodeHash(padded[i], padded[i + 1]));
  }
  return next;
}

/** Merkle root over the events' `chainHash` values. Empty → `sha256('')`. */
export function computeMerkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return sha256hex('');
  let layer = hashes.map(leafHash);
  while (layer.length > 1) {
    layer = nextLayer(layer);
  }
  return layer[0];
}

export function computeMerkleProof(
  hashes: string[],
  index: number,
): MerkleProof {
  if (!Number.isInteger(index) || index < 0 || index >= hashes.length) {
    throw new RangeError(
      `computeMerkleProof: index ${index} out of range for ${hashes.length} leaves`,
    );
  }

  const siblings: string[] = [];
  const directions: ('left' | 'right')[] = [];

  let layer = hashes.map(leafHash);
  let idx = index;

  while (layer.length > 1) {
    const padded =
      layer.length % 2 === 1 ? [...layer, layer[layer.length - 1]] : layer;
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    siblings.push(padded[siblingIdx]);
    directions.push(idx % 2 === 0 ? 'right' : 'left');
    layer = nextLayer(layer);
    idx = Math.floor(idx / 2);
  }

  return { index, siblings, directions };
}

/**
 * Verifies a Merkle proof for an event's `chainHash` (the raw chain hash —
 * the leaf tag is applied internally).
 *
 * Rejects malformed proofs: `siblings`/`directions` length mismatch, or
 * directions inconsistent with `proof.index` (each level's direction is
 * fully determined by the index).
 */
export function verifyMerkleProof(
  leafChainHash: string,
  proof: MerkleProof,
  root: string,
): boolean {
  if (
    !Number.isInteger(proof.index) ||
    proof.index < 0 ||
    proof.siblings.length !== proof.directions.length
  ) {
    return false;
  }

  let current = leafHash(leafChainHash);
  let idx = proof.index;
  for (let i = 0; i < proof.siblings.length; i++) {
    const expectedDir = idx % 2 === 0 ? 'right' : 'left';
    if (proof.directions[i] !== expectedDir) return false;
    const sibling = proof.siblings[i];
    current =
      expectedDir === 'right'
        ? nodeHash(current, sibling)
        : nodeHash(sibling, current);
    idx = Math.floor(idx / 2);
  }
  return current === root;
}
