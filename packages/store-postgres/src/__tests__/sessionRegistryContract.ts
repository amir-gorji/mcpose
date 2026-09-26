/**
 * Conformance suite for mcpose's `SessionRegistry` contract, derived from how
 * `startHttpProxy` drives it. Kept per-package like the `EventStore` suite.
 */
import { describe, it, expect } from 'vitest';
import type { SessionRecord, SessionRegistry } from 'mcpose';

const record = (expiresAt?: number): SessionRecord => ({
  initialize: {
    protocolVersion: '2025-11-25',
    capabilities: { roots: { listChanged: true } },
    clientInfo: { name: 'contract ✓', version: '1.0.0' },
  },
  identity: {
    sub: 'alice',
    type: 'human',
    roles: ['reader'],
    claims: { dept: 'ops', nested: { ok: true, note: 'ünïcode' } },
    resolvedAt: '2026-01-01T00:00:00.000Z',
    source: 'custom',
  },
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

export function describeSessionRegistryContract(
  name: string,
  makeRegistry: () => Promise<SessionRegistry>,
): void {
  describe(`SessionRegistry contract: ${name}`, () => {
    it('round-trips a record, identity and all', async () => {
      const registry = await makeRegistry();
      const stored = record(Date.now() + 60_000);
      await registry.set('s1', stored);
      expect(await registry.get('s1')).toEqual(stored);
    });

    it('keeps a record without a deadline', async () => {
      const registry = await makeRegistry();
      await registry.set('s1', record());
      expect(await registry.get('s1')).toEqual(record());
    });

    it('reports an unknown id as undefined', async () => {
      const registry = await makeRegistry();
      expect(await registry.get('nope')).toBeUndefined();
    });

    it('reports a record past its deadline as undefined', async () => {
      const registry = await makeRegistry();
      await registry.set('s1', record(Date.now() - 1));
      expect(await registry.get('s1')).toBeUndefined();
    });

    it('overwrites on a second set', async () => {
      const registry = await makeRegistry();
      await registry.set('s1', record());
      const updated: SessionRecord = {
        initialize: record().initialize,
        expiresAt: Date.now() + 60_000,
      };
      await registry.set('s1', updated);
      expect(await registry.get('s1')).toEqual(updated);
    });

    it('forgets a deleted record and tolerates deleting an unknown one', async () => {
      const registry = await makeRegistry();
      await registry.set('s1', record());
      await registry.delete('s1');
      expect(await registry.get('s1')).toBeUndefined();
      await expect(registry.delete('s1')).resolves.toBeUndefined();
    });

    it('keeps sessions apart', async () => {
      const registry = await makeRegistry();
      await registry.set('s1', record());
      await registry.set('s2', record(Date.now() + 60_000));
      await registry.delete('s1');
      expect((await registry.get('s2'))?.identity?.sub).toBe('alice');
    });
  });
}
