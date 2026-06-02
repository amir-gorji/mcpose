import { describe, it, expect } from 'vitest';
import {
  assertAuditChainIntegrity,
  assertReplayManifestValid,
  assertPiiRedacted,
  assertDelegationHonored,
} from '../index.js';
import {
  createAuditMiddleware,
  createDefaultSigningKeyProvider,
  createSensitivityResolver,
} from '@mcpose/audit';
import type { AuditEvent } from '@mcpose/audit';
import { createProxyContext } from 'mcpose';
import type { Identity } from 'mcpose';

const identity: Identity = {
  sub: 'test-user',
  type: 'human',
  roles: [],
  claims: {},
  resolvedAt: '2026-06-01T00:00:00.000Z',
  source: 'jwt',
};

function makeHandle(overrideTier?: 'low' | 'medium' | 'high') {
  return createAuditMiddleware({
    signingKey: createDefaultSigningKeyProvider('test-secret'),
    sensitivityResolver: createSensitivityResolver(
      {},
      overrideTier ? () => overrideTier : undefined,
    ),
    onEvent: () => {},
  });
}

async function collectEvents(n: number, sessionId = 'test-session') {
  const events: AuditEvent[] = [];
  const { middleware, closeSession } = createAuditMiddleware({
    signingKey: createDefaultSigningKeyProvider('test-secret'),
    sensitivityResolver: createSensitivityResolver({ search: 'low' }),
    onEvent: (e) => { events.push(e); },
  });
  const ctx = createProxyContext({ transport: 'http', identity, sessionId });
  for (let i = 0; i < n; i++) {
    await middleware(
      { method: 'tools/call', params: { name: 'search', arguments: {} } } as Parameters<typeof middleware>[0],
      async () => ({ content: [] }),
      ctx,
    );
  }
  const manifest = await closeSession(sessionId);
  return { events, manifest };
}

describe('assertAuditChainIntegrity', () => {
  it('passes for a valid chain', async () => {
    const { events } = await collectEvents(10);
    expect(() => assertAuditChainIntegrity(events)).not.toThrow();
  });

  it('passes for empty events', () => {
    expect(() => assertAuditChainIntegrity([])).not.toThrow();
  });

  it('throws when replayManifestPosition is out of order', async () => {
    const { events } = await collectEvents(3);
    // Swap positions to simulate tamper
    const tampered = [...events];
    tampered[0] = { ...tampered[0], replayManifestPosition: 99 };
    expect(() => assertAuditChainIntegrity(tampered)).toThrow(/replayManifestPosition/);
  });

  it('throws when a chainHash is duplicated (tampered/replayed entry)', async () => {
    const { events } = await collectEvents(3);
    const tampered = [...events];
    tampered[2] = { ...tampered[1], replayManifestPosition: 2 };
    expect(() => assertAuditChainIntegrity(tampered)).toThrow(/duplicate chainHash/);
  });
});

describe('assertReplayManifestValid', () => {
  it('passes for a valid manifest', async () => {
    const { events, manifest } = await collectEvents(5);
    expect(manifest).toBeDefined();
    expect(() => assertReplayManifestValid(events, manifest!)).not.toThrow();
  });

  it('throws when event count does not match', async () => {
    const { events, manifest } = await collectEvents(3);
    expect(() => assertReplayManifestValid(events.slice(0, 2), manifest!)).toThrow(/eventCount/);
  });
});

describe('assertPiiRedacted', () => {
  it('passes when no PII pattern matches a low-tier event', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = makeHandle('low');
    await middleware(
      { method: 'tools/call', params: { name: 'search', arguments: { q: 'hello' } } } as Parameters<typeof middleware>[0],
      async () => ({ content: [] }),
      createProxyContext({ transport: 'http', identity }),
    );
    // Low tier — inputRaw is present; no SSN here
    const { events: evts } = await collectEvents(1);
    expect(() => assertPiiRedacted(evts[0], [/\d{3}-\d{2}-\d{4}/])).not.toThrow();
  });

  it('throws when PII pattern matches plaintext in a low-tier event', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware({
      signingKey: createDefaultSigningKeyProvider('s'),
      sensitivityResolver: () => 'low',
      onEvent: (e) => { events.push(e); },
    });
    await middleware(
      { method: 'tools/call', params: { name: 'x', arguments: { ssn: '123-45-6789' } } } as Parameters<typeof middleware>[0],
      async () => ({ content: [] }),
      createProxyContext({ transport: 'http', identity }),
    );
    expect(() => assertPiiRedacted(events[0], [/\d{3}-\d{2}-\d{4}/])).toThrow(/PII pattern/);
  });

  it('passes for a high-tier event regardless of content (encrypted)', async () => {
    const events: AuditEvent[] = [];
    const { middleware } = createAuditMiddleware({
      signingKey: createDefaultSigningKeyProvider('s'),
      sensitivityResolver: () => 'high',
      onEvent: (e) => { events.push(e); },
    });
    await middleware(
      { method: 'tools/call', params: { name: 'x', arguments: { ssn: '123-45-6789' } } } as Parameters<typeof middleware>[0],
      async () => ({ content: [] }),
      createProxyContext({ transport: 'http', identity }),
    );
    expect(() => assertPiiRedacted(events[0], [/\d{3}-\d{2}-\d{4}/])).not.toThrow();
  });
});

describe('assertDelegationHonored', () => {
  it('passes for a non-empty chain', () => {
    expect(() => assertDelegationHonored([identity])).not.toThrow();
  });

  it('throws for an empty chain', () => {
    expect(() => assertDelegationHonored([])).toThrow(/empty/);
  });

  it('throws when an entry has no sub', () => {
    expect(() =>
      assertDelegationHonored([{ ...identity, sub: '' }]),
    ).toThrow(/no sub/);
  });
});
