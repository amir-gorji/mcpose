import { createHmac } from 'node:crypto';
import type { SigningKeyProvider } from './types.js';

// keyId derivation label. v1 used bare SHA256(secret), which let anyone
// holding a manifest brute-force a low-entropy secret offline from the
// published keyId. HMAC with a domain label is not invertible into a
// dictionary check any faster than attacking the signature itself, and
// keeps keyId stable per secret. See ADR-0004.
const DOMAIN_KEYID = 'mcpose/v2/keyid';

/**
 * In-process HMAC-SHA256 signing provider.
 *
 * The secret must be high-entropy (>= 32 random bytes). `keyId` is PUBLIC —
 * it is published in every ReplayManifest — so it must never be used as key
 * material (ADR-0003), and a guessable secret is offline-attackable from
 * any published manifest.
 */
export function createDefaultSigningKeyProvider(
  secret: Buffer | string,
): SigningKeyProvider {
  const secretBuf = typeof secret === 'string' ? Buffer.from(secret) : secret;
  const keyId = createHmac('sha256', secretBuf)
    .update(DOMAIN_KEYID)
    .digest('hex');

  return {
    algorithm: 'HMAC-SHA256',
    keyId,
    async sign(data: Buffer): Promise<Buffer> {
      return createHmac('sha256', secretBuf).update(data).digest();
    },
  };
}
