import { timingSafeEqual } from 'node:crypto';
import type { AuditEvent, ReplayManifest, SigningKeyProvider } from './types.js';
import { chainPreimageFields, computeChainHash } from './chain.js';
import { manifestSigningPayload } from './middleware.js';

const DOMAIN_CHAIN = Buffer.from('mcpose/v2/chain');

export type ChainVerification =
  | { valid: true }
  | { valid: false; index: number; reason: string };

function hexEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
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

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
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
