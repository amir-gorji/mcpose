import { describe, expect, it } from 'vitest';
import {
  computeMerkleProof,
  computeMerkleRoot,
  computeMerkleRootAndProofs,
  verifyMerkleProof,
} from '../chain.js';

describe('batched Merkle root and proofs', () => {
  it('matches the existing root and individual proofs for empty, odd, and even trees', () => {
    for (let size = 0; size <= 17; size++) {
      const hashes = Array.from(
        { length: size },
        (_, index) => `hash-${index}`,
      );
      const { merkleRoot, merkleProofs } = computeMerkleRootAndProofs(hashes);

      expect(merkleRoot).toBe(computeMerkleRoot(hashes));
      expect(merkleProofs).toEqual(
        hashes.map((_, index) => computeMerkleProof(hashes, index)),
      );

      for (let index = 0; index < hashes.length; index++) {
        expect(
          verifyMerkleProof(hashes[index]!, merkleProofs[index]!, merkleRoot),
        ).toBe(true);
      }
    }
  });
});
