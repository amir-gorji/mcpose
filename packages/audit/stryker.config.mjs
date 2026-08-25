// Stryker validates these options against its own schema at run time.
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  // pnpm's isolated node_modules defeats Stryker's plugin auto-discovery.
  plugins: ['@stryker-mutator/vitest-runner'],
  mutate: ['src/**/*.ts', '!src/__tests__/**'],
  reporters: ['progress', 'clear-text'],
  incremental: true,
  incrementalFile: '.stryker-tmp/incremental.json',
  // The sandbox copy would sit two directories deeper than the package, which
  // breaks the relative `extends` in tsconfig.json and fails the dry run.
  inPlace: true,
  concurrency: 4,
  // Ratchet policy: raise-only, the same rule as the coverage thresholds in
  // vitest.config.ts. Lowering `break` requires an ADR-level justification.
  // Set to the measured baseline mutation score rounded down minus 2 points.
  // Baseline on 2026-08-26: 73.73 (312 killed, 8 timeout, 90 survived, 24 no cov).
  thresholds: { high: 80, low: 74, break: 71 },
};
