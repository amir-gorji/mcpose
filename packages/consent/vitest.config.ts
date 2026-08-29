import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/__tests__/**'],
      reporter: ['text-summary'],
      // Ratchet policy: raise-only. Lowering a threshold requires an ADR-level
      // justification. Set to measured coverage rounded down minus 2 points.
      thresholds: {
        statements: 98,
        branches: 98,
        functions: 98,
        lines: 98,
      },
    },
  },
});
