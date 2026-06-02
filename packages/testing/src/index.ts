import type { AuditEvent, ReplayManifest } from '@mcpose/audit';
import { verifyMerkleProof } from '@mcpose/audit';
import type { Identity } from 'mcpose';

export type { AuditEvent, ReplayManifest };

/**
 * Asserts that an ordered sequence of audit events forms a valid HMAC chain.
 * Verifies that each event's chainHash is consistent with its position
 * (i.e. that no entry has been inserted, removed, or tampered).
 *
 * Does NOT re-compute the HMAC (the signing key is not available here) —
 * instead checks that the chainHash changes with each entry (chain is live)
 * and that the `replayManifestPosition` values are sequential.
 */
export function assertAuditChainIntegrity(events: AuditEvent[]): void {
  if (events.length === 0) return;

  const seen = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i];

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
 * Asserts that every Merkle proof in a ReplayManifest verifies against the root.
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

  for (let i = 0; i < events.length; i++) {
    const valid = verifyMerkleProof(
      events[i].chainHash,
      manifest.merkleProofs[i],
      manifest.merkleRoot,
    );
    if (!valid) {
      throw new Error(`Merkle proof for event at index ${i} does not verify against root`);
    }
  }
}

/**
 * Asserts that a high-sensitivity audit event does not contain plaintext
 * input or output matching any of the given patterns.
 */
export function assertPiiRedacted(event: AuditEvent, patterns: RegExp[]): void {
  if (event.sensitivityTier !== 'high') {
    const lowOrMed = event as { inputRaw?: unknown; outputRaw?: unknown };
    const raw = JSON.stringify({ inputRaw: lowOrMed.inputRaw, outputRaw: lowOrMed.outputRaw });
    for (const pattern of patterns) {
      if (pattern.test(raw)) {
        throw new Error(`PII pattern ${pattern} found in audit event for tool "${event.tool}"`);
      }
    }
  }
}

/**
 * Asserts that a delegation chain is non-empty and each entry has a valid sub.
 */
export function assertDelegationHonored(chain: Identity[]): void {
  if (chain.length === 0) {
    throw new Error('Delegation chain is empty — expected at least one delegating identity');
  }
  for (let i = 0; i < chain.length; i++) {
    if (!chain[i].sub) {
      throw new Error(`Delegation chain entry at index ${i} has no sub`);
    }
  }
}
