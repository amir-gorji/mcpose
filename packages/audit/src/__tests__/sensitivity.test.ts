import { describe, it, expect } from 'vitest';
import { createSensitivityResolver } from '../sensitivity.js';
import type { Identity } from 'mcpose';

const identity: Identity = {
  sub: 'u1',
  type: 'human',
  roles: [],
  claims: {},
  resolvedAt: new Date().toISOString(),
  source: 'jwt',
};

describe('createSensitivityResolver', () => {
  it('returns the mapped tier for a known tool', () => {
    const resolve = createSensitivityResolver({ transfer_funds: 'high', get_balance: 'low' });
    expect(resolve('transfer_funds', identity, {})).toBe('high');
    expect(resolve('get_balance', identity, {})).toBe('low');
  });

  it('returns high for an unknown tool', () => {
    const resolve = createSensitivityResolver({ get_balance: 'low' });
    expect(resolve('unknown_tool', identity, {})).toBe('high');
  });

  it('override fn takes precedence over the static map', () => {
    const resolve = createSensitivityResolver(
      { get_balance: 'low' },
      (_tool, _identity, args) => (args.pii ? 'high' : 'low'),
    );
    expect(resolve('get_balance', identity, { pii: true })).toBe('high');
    expect(resolve('get_balance', identity, {})).toBe('low');
  });
});
