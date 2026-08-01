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

  it('override receives the map tier and can fall back to it', () => {
    const resolve = createSensitivityResolver(
      { get_balance: 'medium' },
      (_tool, _identity, _args, mapTier) => mapTier,
    );
    expect(resolve('get_balance', identity, {})).toBe('medium');
    // Unknown tool: mapTier is already defaulted to high.
    expect(resolve('unknown_tool', identity, {})).toBe('high');
  });

  it('resolves prototype-inherited tool names to high (attacker-controlled names)', () => {
    const resolve = createSensitivityResolver({ get_balance: 'low' });
    // These exist on Object.prototype — a naive map lookup returns a
    // truthy Function, bypassing the unknown⇒high default.
    for (const tool of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(resolve(tool, identity, {})).toBe('high');
    }
  });

  it('treats a garbage tier from the map or override as high (fail closed)', () => {
    const badMap = createSensitivityResolver({
      typo_tool: 'pubic' as never,
    });
    expect(badMap('typo_tool', identity, {})).toBe('high');

    const badOverride = createSensitivityResolver(
      {},
      () => undefined as never,
    );
    expect(badOverride('anything', identity, {})).toBe('high');
  });
});
