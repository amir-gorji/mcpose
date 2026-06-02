import { describe, it, expect } from 'vitest';
import { createDefaultSigningKeyProvider } from '../signingKey.js';

describe('createDefaultSigningKeyProvider', () => {
  it('has correct shape', () => {
    const provider = createDefaultSigningKeyProvider('secret');
    expect(provider.algorithm).toBe('HMAC-SHA256');
    expect(typeof provider.keyId).toBe('string');
    expect(provider.keyId.length).toBeGreaterThan(0);
    expect(typeof provider.sign).toBe('function');
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

  it('accepts Buffer as secret', async () => {
    const provider = createDefaultSigningKeyProvider(Buffer.from('secret'));
    const sig = await provider.sign(Buffer.from('data'));
    expect(sig).toBeInstanceOf(Buffer);
  });
});
