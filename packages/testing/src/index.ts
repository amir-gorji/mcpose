import type { AuditEvent, ReplayManifest } from '@mcpose/audit';
import { computeMerkleRoot, verifyMerkleProof } from '@mcpose/audit';

export type { AuditEvent, ReplayManifest };

/**
 * Asserts structural integrity of an ordered audit event sequence:
 * positions are sequential and every chainHash is non-empty and distinct.
 * Throws on an empty sequence — a log truncated to zero events must not
 * pass a compliance assertion.
 *
 * This check is deliberately KEYLESS (the signing secret is not available
 * to tests): it catches reordering, renumbering, duplicated entries, and
 * head or middle deletion. It does NOT prove authenticity — a forger who
 * rewrites every event and regenerates the chain hashes produces a document
 * these checks accept without needing the signing secret at all. Tail
 * truncation also passes this check alone; the manifest's `eventCount`
 * is what catches it. For keyed verification, use
 * `verifyAuditChain(events, signingKey)` from `@mcpose/audit`.
 */
export function assertAuditChainIntegrity(events: AuditEvent[]): void {
  if (events.length === 0) {
    throw new Error(
      'Audit chain is empty — a truncated-to-zero log must not pass. ' +
        'If an empty session is expected, assert that explicitly.',
    );
  }

  const seen = new Set<string>();
  for (const [i, event] of events.entries()) {
    if (event.replayManifestPosition !== i) {
      throw new Error(
        `Audit chain broken at index ${i}: replayManifestPosition is ${event.replayManifestPosition}, expected ${i}`,
      );
    }

    if (!event.chainHash || event.chainHash.length === 0) {
      throw new Error(`Audit chain broken at index ${i}: chainHash is empty`);
    }

    if (seen.has(event.chainHash)) {
      throw new Error(
        `Audit chain broken at index ${i}: duplicate chainHash "${event.chainHash}" — chain has been tampered`,
      );
    }
    seen.add(event.chainHash);
  }
}

/**
 * Asserts that a ReplayManifest is consistent with its event sequence:
 * the Merkle root recomputes from the events' chainHashes, there is
 * exactly one proof per event, and every proof verifies against the root
 * at its own index.
 *
 * Keyless: does NOT verify the manifest signature — use
 * `verifyManifestSignature(manifest, signingKey)` from `@mcpose/audit`.
 */
export function assertReplayManifestValid(
  events: AuditEvent[],
  manifest: ReplayManifest,
): void {
  if (manifest.eventCount !== events.length) {
    throw new Error(
      `ReplayManifest eventCount (${manifest.eventCount}) does not match events array length (${events.length})`,
    );
  }
  if (manifest.merkleProofs.length !== events.length) {
    throw new Error(
      `ReplayManifest has ${manifest.merkleProofs.length} Merkle proofs for ${events.length} events`,
    );
  }

  // The root must recompute from the events under test — a root swapped to
  // match a doctored event set fails here even without the signing key.
  const recomputedRoot = computeMerkleRoot(events.map((e) => e.chainHash));
  if (recomputedRoot !== manifest.merkleRoot) {
    throw new Error(
      'ReplayManifest merkleRoot does not recompute from the events under test',
    );
  }

  for (const [i, proof] of manifest.merkleProofs.entries()) {
    if (proof.index !== i) {
      throw new Error(`Merkle proof at index ${i} claims index ${proof.index}`);
    }
    // The lengths were just checked to be equal.
    if (!verifyMerkleProof(events[i]!.chainHash, proof, manifest.merkleRoot)) {
      throw new Error(
        `Merkle proof for event at index ${i} does not verify against root`,
      );
    }
  }
}

/**
 * Asserts sensitivity handling on a single event.
 *
 * - low/medium: no given PII pattern matches the plaintext
 *   `inputRaw`/`outputRaw`.
 * - high: the event is structurally encrypted — `inputRaw`/`outputRaw`
 *   are ABSENT and `inputEncrypted`/`outputEncrypted` are present. The
 *   patterns are NOT checked against high events (the payload is
 *   ciphertext); this assertion cannot prove what is inside it.
 */
export function assertPiiRedacted(event: AuditEvent, patterns: RegExp[]): void {
  if (event.sensitivityTier === 'high') {
    const leaked = event as { inputRaw?: unknown; outputRaw?: unknown };
    if (leaked.inputRaw !== undefined || leaked.outputRaw !== undefined) {
      throw new Error(
        `High-sensitivity audit event for tool "${event.tool}" carries plaintext inputRaw/outputRaw`,
      );
    }
    if (!event.inputEncrypted || !event.outputEncrypted) {
      throw new Error(
        `High-sensitivity audit event for tool "${event.tool}" is missing encrypted payloads`,
      );
    }
    return;
  }

  const raw = JSON.stringify({
    inputRaw: event.inputRaw,
    outputRaw: event.outputRaw,
  });
  for (const pattern of patterns) {
    if (pattern.test(raw)) {
      throw new Error(
        `PII pattern ${pattern} found in audit event for tool "${event.tool}"`,
      );
    }
  }
}

/**
 * Asserts that an audit event carries a delegation chain: `delegatedFrom`
 * is present, non-empty, and every entry has a `sub`.
 *
 * Does NOT verify delegation signatures or chain continuity (v3).
 * Note: mcpose core does not populate `delegatedFrom` yet — it is stamped
 * only when the host places it on the ProxyContext.
 */
export function assertDelegationHonored(event: AuditEvent): void {
  const chain = event.delegatedFrom;
  if (chain === undefined || chain.length === 0) {
    throw new Error(
      `Audit event for tool "${event.tool}" has no delegation chain — expected at least one delegating identity`,
    );
  }
  for (const [i, entry] of chain.entries()) {
    if (!entry.sub) {
      throw new Error(`Delegation chain entry at index ${i} has no sub`);
    }
  }
}
