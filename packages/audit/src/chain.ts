import { createHash, createHmac } from 'node:crypto';
import type { MerkleProof } from './types.js';

export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256hex(data: string | Buffer, key: Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/**
 * HMAC-SHA256(JSON(entryWithoutChainHash) + prevChainHash, signingKey).
 * The entry is serialized without its own chainHash to avoid circular dependency.
 */
export function computeChainHash(
  entryWithoutChainHash: Record<string, unknown>,
  prevChainHash: string,
  signingKey: Buffer,
): string {
  const data = JSON.stringify(entryWithoutChainHash) + prevChainHash;
  return hmacSha256hex(data, signingKey);
}

function nextPow2Layer(hashes: string[]): string[] {
  const layer = [...hashes];
  // Pad to even length by duplicating the last node (standard Merkle convention)
  if (layer.length % 2 === 1) layer.push(layer[layer.length - 1]);
  const next: string[] = [];
  for (let i = 0; i < layer.length; i += 2) {
    next.push(sha256hex(layer[i] + layer[i + 1]));
  }
  return next;
}

export function computeMerkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return sha256hex('');
  if (hashes.length === 1) return hashes[0];
  let layer = [...hashes];
  while (layer.length > 1) {
    layer = nextPow2Layer(layer);
  }
  return layer[0];
}

export function computeMerkleProof(hashes: string[], index: number): MerkleProof {
  const siblings: string[] = [];
  const directions: ('left' | 'right')[] = [];

  let layer = [...hashes];
  let idx = index;

  while (layer.length > 1) {
    // Pad odd layers
    if (layer.length % 2 === 1) layer.push(layer[layer.length - 1]);

    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    siblings.push(layer[siblingIdx]);
    directions.push(idx % 2 === 0 ? 'right' : 'left');

    layer = nextPow2Layer(layer.slice(0, layer.length));
    idx = Math.floor(idx / 2);
  }

  return { index, siblings, directions };
}

export function verifyMerkleProof(
  leafHash: string,
  proof: MerkleProof,
  root: string,
): boolean {
  let current = leafHash;
  for (let i = 0; i < proof.siblings.length; i++) {
    const sibling = proof.siblings[i];
    const dir = proof.directions[i];
    current = dir === 'right'
      ? sha256hex(current + sibling)
      : sha256hex(sibling + current);
  }
  return current === root;
}
