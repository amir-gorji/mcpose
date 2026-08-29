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
  // Baseline on 2026-08-29: 79.46 (1059 killed, 1 timeout, 227 survived, 47 no cov),
  // measured after mandatory ProxyOptions.name landed (#122) on top of the
  // delegation wire format (#124). floor(79.46) - 2 is 77, which does not beat
  // the existing 77, so the raise-only ratchet leaves `break` where it is.
  // Measure on an idle machine: a concurrent Stryker run inflates the score by
  // turning survivors into timeouts, which count as killed.
  thresholds: { high: 75, low: 67, break: 77 },
};
