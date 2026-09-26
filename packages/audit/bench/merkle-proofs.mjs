import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  computeMerkleProof,
  computeMerkleRoot,
  computeMerkleRootAndProofs,
} from '../dist/chain.js';

const trials = 3;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(operation) {
  const samples = [];
  let result;

  for (let trial = 0; trial < trials; trial++) {
    const start = performance.now();
    result = operation();
    samples.push(performance.now() - start);
  }

  return { medianMs: median(samples), result };
}

for (const size of [500, 1000, 2000]) {
  const hashes = Array.from({ length: size }, (_, index) => String(index));
  const repeated = measure(() => ({
    merkleRoot: computeMerkleRoot(hashes),
    merkleProofs: hashes.map((_, index) => computeMerkleProof(hashes, index)),
  }));
  const batched = measure(() => computeMerkleRootAndProofs(hashes));

  assert.deepEqual(batched.result, repeated.result);

  const speedup = (repeated.medianMs / batched.medianMs).toFixed(1);
  console.log(
    `${size}: legacy root-plus-per-proof ${repeated.medianMs.toFixed(1)} ms; shared tree ${batched.medianMs.toFixed(1)} ms; ${speedup}x faster`,
  );
}
