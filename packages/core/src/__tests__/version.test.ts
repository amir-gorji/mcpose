import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { VERSION } from '../version.js';

describe('VERSION', () => {
  it('matches package.json (bump src/version.ts together with the package)', () => {
    const pkg = createRequire(import.meta.url)('../../package.json') as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
