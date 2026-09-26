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
  // Measure on an idle machine: a concurrent Stryker run inflates the score by
  // turning survivors into timeouts, which count as killed.
  // Baseline on 2026-09-26: 96.15 (25 killed, 0 timeout, 1 survived, 0 no cov),
  // measured from a clean incremental report when the package joined the
  // lane (#160). floor(96.15) - 2 is 94.
  thresholds: { high: 90, low: 94, break: 94 },
};
