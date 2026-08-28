import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { createDefaultSigningKeyProvider } from '../signingKey.js';

describe('createDefaultSigningKeyProvider', () => {
  it('has correct shape', () => {
    const provider = createDefaultSigningKeyProvider('secret');
    expect(provider.algorithm).toBe('HMAC-SHA256');
    expect(typeof provider.keyId).toBe('string');
    expect(provider.keyId.length).toBeGreaterThan(0);
    expect(typeof provider.sign).toBe('function');
  });

  it('derives keyId as HMAC(secret, mcpose/v2/keyid), never bare SHA256(secret)', () => {
    // v1 published SHA256(secret) as keyId, enabling offline brute-force of
    // low-entropy secrets from any manifest. Pin the v2 formula and the label.
    const provider = createDefaultSigningKeyProvider('secret');
    expect(provider.keyId).toBe(
      createHmac('sha256', Buffer.from('secret'))
        .update('mcpose/v2/keyid')
        .digest('hex'),
    );
    expect(provider.keyId).not.toBe(
      createHash('sha256').update('secret').digest('hex'),
    );
  });

  it('sign returns a non-empty buffer', async () => {
    const provider = createDefaultSigningKeyProvider('secret');
    const sig = await provider.sign(Buffer.from('hello'));
    expect(sig).toBeInstanceOf(Buffer);
    expect(sig.length).toBeGreaterThan(0);
  });

  it('same secret + same data → same signature (deterministic)', async () => {
    const p1 = createDefaultSigningKeyProvider('secret');
    const p2 = createDefaultSigningKeyProvider('secret');
    const data = Buffer.from('test-data');
    const [s1, s2] = await Promise.all([p1.sign(data), p2.sign(data)]);
    expect(s1.toString('hex')).toBe(s2.toString('hex'));
  });

  it('different secrets → different signatures', async () => {
    const p1 = createDefaultSigningKeyProvider('secret-a');
    const p2 = createDefaultSigningKeyProvider('secret-b');
    const data = Buffer.from('test-data');
    const [s1, s2] = await Promise.all([p1.sign(data), p2.sign(data)]);
    expect(s1.toString('hex')).not.toBe(s2.toString('hex'));
  });

  it('accepts a Buffer secret and keys it identically to its utf8 string form', async () => {
    // Pins why the provider hands the secret to createHmac as given rather
    // than normalizing a string to a Buffer first: createHmac encodes a
    // string key as utf8 itself, so the conversion was unobservable and its
    // mutants unkillable (#110). A non-ASCII secret makes the encoding
    // load-bearing rather than incidental.
    const text = 'sécret';
    const fromString = createDefaultSigningKeyProvider(text);
    const fromBuffer = createDefaultSigningKeyProvider(Buffer.from(text));

    expect(fromBuffer.keyId).toBe(fromString.keyId);
    expect(fromBuffer.keyId).toBe(
      createHmac('sha256', Buffer.from(text, 'utf8'))
        .update('mcpose/v2/keyid')
        .digest('hex'),
    );

    const data = Buffer.from('data');
    const [fromBufferSig, fromStringSig] = await Promise.all([
      fromBuffer.sign(data),
      fromString.sign(data),
    ]);
    expect(fromBufferSig).toBeInstanceOf(Buffer);
    expect(fromBufferSig.toString('hex')).toBe(fromStringSig.toString('hex'));
  });
});
