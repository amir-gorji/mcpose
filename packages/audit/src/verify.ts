import { timingSafeEqual } from 'node:crypto';
import type {
  AuditEvent,
  ReplayManifest,
  SigningKeyProvider,
} from './types.js';
import { chainPreimageFields, computeChainHash } from './chain.js';
import { manifestSigningPayload } from './middleware.js';

const DOMAIN_CHAIN = Buffer.from('mcpose/v2/chain');

export type ChainVerification =
  { valid: true } | { valid: false; index: number; reason: string };

/**
 * Canonical hex: lowercase, even length, hex digits only, non-empty. This
 * is what the producer writes (`digest('hex')`), and the exact string a
 * third-party verifier compares.
 */
const CANONICAL_HEX = /^(?:[0-9a-f]{2})+$/;

/**
 * Compares a stored hex string against the recomputed value in constant
 * time. The stored string must be canonical first: Node's hex decoder drops
 * a trailing odd nibble and stops at the first non-hex character, so
 * `sig + '0'`, `sig + 'z'` and `SIG` all decode to the stored bytes and would
 * otherwise verify. The verifiers authenticate the stored string itself, not
 * just its decoding, so two implementations agree on one artifact (#281).
 */
function hexEqual(storedHex: string, expectedHex: string): boolean {
  if (!CANONICAL_HEX.test(storedHex)) return false;
  const a = Buffer.from(storedHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * KEYED chain verification: recomputes every event's chainHash from its
 * preimage fields with the chain key derived through the signing oracle.
 * Unlike the keyless `assertAuditChainIntegrity` in @mcpose/testing, this
 * detects key-inconsistent forgeries — a rewritten event, a renumbered
 * suffix, or a chain built under a different secret.
 *
 * An empty event list is invalid: truncation-to-zero must not verify.
 */
export async function verifyAuditChain(
  events: readonly AuditEvent[],
  signingKey: SigningKeyProvider,
): Promise<ChainVerification> {
  if (events.length === 0) {
    return { valid: false, index: 0, reason: 'empty event list' };
  }

  const chainKey = await signingKey.sign(DOMAIN_CHAIN);
  let prevChainHash = '';

  for (const [i, event] of events.entries()) {
    if (event.replayManifestPosition !== i) {
      return {
        valid: false,
        index: i,
        reason: `replayManifestPosition ${event.replayManifestPosition}, expected ${i}`,
      };
    }
    const expected = computeChainHash(
      chainPreimageFields(event),
      prevChainHash,
      chainKey,
    );
    if (!hexEqual(event.chainHash, expected)) {
      return { valid: false, index: i, reason: 'chainHash mismatch' };
    }
    prevChainHash = event.chainHash;
  }

  return { valid: true };
}

/**
 * Recomputes the manifest's signature (which covers every manifest field,
 * not just the Merkle root) and compares it in constant time.
 */
export async function verifyManifestSignature(
  manifest: ReplayManifest,
  signingKey: SigningKeyProvider,
): Promise<boolean> {
  const { signature, ...unsigned } = manifest;
  const expected = await signingKey.sign(
    Buffer.from(manifestSigningPayload(unsigned)),
  );
  return hexEqual(signature, expected.toString('hex'));
}
