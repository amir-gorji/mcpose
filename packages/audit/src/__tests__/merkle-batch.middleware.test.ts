import { describe, expect, it, vi } from 'vitest';

const sha256Calls = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return {
    ...original,
    createHash: (...args: Parameters<typeof original.createHash>) => {
      if (args[0] === 'sha256') sha256Calls.count += 1;
      return original.createHash(...args);
    },
  };
});

import { createProxyContext } from 'mcpose';
import type { Identity } from 'mcpose';
import { createAuditMiddleware } from '../middleware.js';
import { createDefaultSigningKeyProvider } from '../signingKey.js';
import { createSensitivityResolver } from '../sensitivity.js';
import type { AuditEvent } from '../types.js';
import { computeMerkleProof, computeMerkleRoot } from '../chain.js';

const identity: Identity = {
  sub: 'user-1',
  type: 'human',
  roles: ['analyst'],
  claims: {},
  resolvedAt: '2026-06-01T00:00:00.000Z',
  source: 'jwt',
};

async function closeSessionWithEvents(sessionId: string, count: number) {
  const events: AuditEvent[] = [];
  const { middleware, closeSession } = createAuditMiddleware({
    signingKey: createDefaultSigningKeyProvider('test-secret'),
    sensitivityResolver: createSensitivityResolver({ search: 'low' }),
    onEvent: (event) => {
      events.push(event);
    },
  });
  const context = () =>
    createProxyContext({
      transport: 'http',
      identity,
      sessionId,
      proxy: { name: 'test-proxy', version: '0.0.0' },
    });

  for (let index = 0; index < count; index++) {
    await middleware(
      {
        method: 'tools/call' as const,
        params: { name: 'search', arguments: { index } },
      },
      async () => ({ content: [] }),
      context(),
    );
  }

  sha256Calls.count = 0;
  const manifest = await closeSession(sessionId);
  return {
    events,
    manifest: manifest!,
    sha256Count: sha256Calls.count,
  };
}

describe('batched proofs in the signed manifest', () => {
  it('keeps the same root and proofs across singleton, odd, and even event counts', async () => {
    for (const count of [1, 2, 3, 4, 5, 8, 9, 17]) {
      const { events, manifest } = await closeSessionWithEvents(
        `batch-${count}`,
        count,
      );
      const hashes = events.map((event) => event.chainHash);

      expect(manifest.merkleRoot).toBe(computeMerkleRoot(hashes));
      expect(manifest.merkleProofs).toEqual(
        hashes.map((_, index) => computeMerkleProof(hashes, index)),
      );
    }
  });

  it('hashes each tree node once while closing a large session', async () => {
    const count = 256;
    const { sha256Count, manifest } = await closeSessionWithEvents(
      'batch-large',
      count,
    );

    expect(manifest.merkleProofs).toHaveLength(count);
    expect(sha256Count).toBe(2 * count - 1);
  });
});
