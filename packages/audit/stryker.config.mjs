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
  // Baseline on 2026-08-26: 83.18 (352 killed, 9 timeout, 57 survived, 16 no cov),
  // measured after the fast-check property suite landed (#60). It was 73.73.
  // Re-measured on 2026-08-29 at 83.82 (390 killed, 9 timeout, 61 survived,
  // 16 no cov) after #110 removed signingKey.ts's four equivalent mutants.
  // floor(83.82) - 2 is 81, so the threshold is unchanged rather than raised.
  // Re-measured on 2026-08-29 at 84.04 (370 killed, 9 timeout, 56 survived,
  // 16 no cov) after #123 made the proxy identity a required covered field,
  // which removed the omission branches around it. floor(84.04) - 2 is 82,
  // so the raise-only ratchet moves the threshold up from 81.
  thresholds: { high: 90, low: 84, break: 82 },
};
