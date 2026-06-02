import { createHmac, createHash } from 'node:crypto';
import type { SigningKeyProvider } from './types.js';

export function createDefaultSigningKeyProvider(
  secret: Buffer | string,
): SigningKeyProvider {
  const secretBuf = typeof secret === 'string' ? Buffer.from(secret) : secret;
  const keyId = createHash('sha256').update(secretBuf).digest('hex');

  return {
    algorithm: 'HMAC-SHA256',
    keyId,
    async sign(data: Buffer): Promise<Buffer> {
      return createHmac('sha256', secretBuf).update(data).digest();
    },
  };
}
