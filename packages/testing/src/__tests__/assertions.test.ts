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
  computeMerkleRoot,
} from '@mcpose/audit';
import type { AuditEvent, SensitivityResolverFn } from '@mcpose/audit';
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

async function collectEvents(
  n: number,
  {
    sessionId = 'test-session',
    resolver = createSensitivityResolver({ search: 'low' }),
    args = {} as Record<string, unknown>,
    delegatedFrom,
  }: {
    sessionId?: string;
    resolver?: SensitivityResolverFn;
    args?: Record<string, unknown>;
    delegatedFrom?: Identity[];
  } = {},
) {
  const events: AuditEvent[] = [];
  const { middleware, closeSession } = createAuditMiddleware({
    signingKey: createDefaultSigningKeyProvider('test-secret'),
    sensitivityResolver: resolver,
    onEvent: (e) => {
      events.push(e);
    },
  });
  for (let i = 0; i < n; i++) {
    await middleware(
      {
        method: 'tools/call',
        params: { name: 'search', arguments: args },
      } as Parameters<typeof middleware>[0],
      async () => ({ content: [] }),
      createProxyContext({ transport: 'http', identity, sessionId, delegatedFrom }),
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

  it('throws for an empty chain (truncation to zero must not pass)', () => {
    expect(() => assertAuditChainIntegrity([])).toThrow(/empty/);
  });

  it('throws when replayManifestPosition is out of order', async () => {
    const { events } = await collectEvents(3);
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

  it('throws when the root does not recompute from the events under test', async () => {
    const { events, manifest } = await collectEvents(3);
    // Doctor one event AND renumber consistently — keyless chain checks
    // pass, but the root recomputation must catch it.
    const doctored = events.map((e, i) =>
      i === 1 ? { ...e, chainHash: `${e.chainHash.slice(0, -1)}0` } : e,
    );
    expect(() => assertReplayManifestValid(doctored, manifest!)).toThrow(/does not recompute/);
  });

  it('throws when the manifest root was swapped to match doctored events', async () => {
    const { events, manifest } = await collectEvents(3);
    const doctored = events.map((e, i) =>
      i === 1 ? { ...e, chainHash: `${e.chainHash.slice(0, -1)}0` } : e,
    );
    // Attacker recomputes a matching root but cannot regenerate the proofs
    // for the untouched leaves.
    const swappedRoot = {
      ...manifest!,
      merkleRoot: computeMerkleRoot(doctored.map((e) => e.chainHash)),
    };
    expect(() => assertReplayManifestValid(doctored, swappedRoot)).toThrow(/does not verify/);
  });

  it('throws when a proof is missing', async () => {
    const { events, manifest } = await collectEvents(3);
    const short = { ...manifest!, merkleProofs: manifest!.merkleProofs.slice(0, 2) };
    expect(() => assertReplayManifestValid(events, short)).toThrow(/Merkle proofs for/);
  });

  it('throws when a proof claims the wrong index', async () => {
    const { events, manifest } = await collectEvents(3);
    const proofs = [...manifest!.merkleProofs];
    [proofs[0], proofs[1]] = [proofs[1], proofs[0]];
    const shuffled = { ...manifest!, merkleProofs: proofs };
    expect(() => assertReplayManifestValid(events, shuffled)).toThrow(/claims index/);
  });
});

describe('assertPiiRedacted', () => {
  const SSN = /\d{3}-\d{2}-\d{4}/;

  it('passes when no PII pattern matches a low-tier event', async () => {
    const { events } = await collectEvents(1, { args: { q: 'hello' } });
    expect(() => assertPiiRedacted(events[0], [SSN])).not.toThrow();
  });

  it('throws when PII pattern matches plaintext in a low-tier event', async () => {
    const { events } = await collectEvents(1, {
      resolver: () => 'low',
      args: { ssn: '123-45-6789' },
    });
    expect(() => assertPiiRedacted(events[0], [SSN])).toThrow(/PII pattern/);
  });

  it('passes for a well-formed high-tier event (payload encrypted)', async () => {
    const { events } = await collectEvents(1, {
      resolver: () => 'high',
      args: { ssn: '123-45-6789' },
    });
    expect(() => assertPiiRedacted(events[0], [SSN])).not.toThrow();
  });

  it('throws for a high-tier event that leaks plaintext fields', async () => {
    const { events } = await collectEvents(1, {
      resolver: () => 'high',
      args: { ssn: '123-45-6789' },
    });
    const leaky = {
      ...events[0],
      inputRaw: { ssn: '123-45-6789' },
    } as AuditEvent;
    expect(() => assertPiiRedacted(leaky, [SSN])).toThrow(/plaintext/);
  });

  it('throws for a high-tier event missing encrypted payloads', async () => {
    const { events } = await collectEvents(1, { resolver: () => 'high' });
    const broken = { ...events[0], inputEncrypted: '' } as AuditEvent;
    expect(() => assertPiiRedacted(broken, [SSN])).toThrow(/missing encrypted/);
  });
});

describe('assertDelegationHonored', () => {
  const delegator: Identity = { ...identity, sub: 'orchestrator-agent', type: 'agent' };

  it('passes for an event with a delegation chain', async () => {
    const { events } = await collectEvents(1, { delegatedFrom: [delegator] });
    expect(() => assertDelegationHonored(events[0])).not.toThrow();
  });

  it('throws for an event without a delegation chain', async () => {
    const { events } = await collectEvents(1);
    expect(() => assertDelegationHonored(events[0])).toThrow(/no delegation chain/);
  });

  it('throws when an entry has no sub', async () => {
    const { events } = await collectEvents(1, {
      delegatedFrom: [{ ...delegator, sub: '' }],
    });
    expect(() => assertDelegationHonored(events[0])).toThrow(/no sub/);
  });
});
