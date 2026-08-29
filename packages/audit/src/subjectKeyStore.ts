import { randomBytes } from 'node:crypto';
import type { SubjectKeyStore } from './types.js';

/**
 * Reference {@link SubjectKeyStore}, backed by a `Map` in this process.
 *
 * NOT DURABLE, and not for production. The keys live only in this process's
 * heap, so a restart erases every subject at once and a second proxy instance
 * cannot decrypt what the first recorded. Both are silent failures: the chain
 * still verifies, and the loss shows up only when someone tries to read a
 * payload back.
 *
 * A real deployment needs a durable, access-controlled store — a KMS, an HSM,
 * or an encrypted table whose read path is audited — because in erasable mode
 * this store IS the confidentiality of every high-tier payload it holds a key
 * for (ADR-0018).
 */
export function createInMemorySubjectKeyStore(): SubjectKeyStore {
  const keys = new Map<string, Buffer>();

  return {
    async getOrCreate(subjectId: string): Promise<Buffer> {
      const existing = keys.get(subjectId);
      if (existing !== undefined) return existing;
      // 256-bit, random rather than derived: a key recomputable from the
      // signing secret could not be destroyed, which is the whole point.
      const created = randomBytes(32);
      keys.set(subjectId, created);
      return created;
    },
    async destroy(subjectId: string) {
      keys.delete(subjectId);
      // Idempotent: an unknown subject still gets a tombstone, so a repeated
      // erasure request produces evidence rather than an error.
      return { destroyedAt: new Date().toISOString() };
    },
  };
}
