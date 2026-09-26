import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { RedisClientType } from 'redis';
import {
  createRedisEventStore,
  createRedisSessionRegistry,
  type RedisEventStoreClient,
  type RedisSessionRegistryClient,
} from '../index.js';
import { FakeRedis } from './fakeRedis.js';
import { describeEventStoreContract } from './eventStoreContract.js';
import { describeSessionRegistryContract } from './sessionRegistryContract.js';

const message = { jsonrpc: '2.0', method: 'ping' } as JSONRPCMessage;

describeEventStoreContract('redis (fake client)', async () =>
  createRedisEventStore(new FakeRedis()),
);

describe('createRedisEventStore()', () => {
  it('accepts a live node-redis client with no cast', () => {
    // If node-redis reshapes a signature, this stops compiling.
    const asClient = (c: RedisClientType): RedisEventStoreClient => c;
    expect(asClient).toBeTypeOf('function');
  });

  it('namespaces keys by stream id under the default prefix', async () => {
    const redis = new FakeRedis();
    const store = createRedisEventStore(redis);
    await store.storeEvent('_GET_stream', message);
    expect(redis.keys()).toEqual(['mcpose:events:_GET_stream']);
  });

  it('honours a custom key prefix', async () => {
    const redis = new FakeRedis();
    const store = createRedisEventStore(redis, { keyPrefix: 'tenant-a:' });
    await store.storeEvent('s1', message);
    expect(redis.keys()).toEqual(['tenant-a:s1']);
  });

  it('expires a stream 30 minutes after its last event by default', async () => {
    const redis = new FakeRedis();
    const store = createRedisEventStore(redis);
    const cursor = await store.storeEvent('s1', message);
    expect(redis.ttlOf('mcpose:events:s1')).toBeCloseTo(30 * 60 * 1000, -3);

    redis.offsetMs = 30 * 60 * 1000 + 1;
    expect(await store.getStreamIdForEventId?.(cursor)).toBeUndefined();
    expect(redis.keys()).toEqual([]);
  });

  it('refreshes the TTL on every write, so a live stream is never dropped', async () => {
    const redis = new FakeRedis();
    const store = createRedisEventStore(redis, { ttlMs: 1000 });
    const cursor = await store.storeEvent('s1', message);
    redis.offsetMs = 900;
    await store.storeEvent('s1', message);
    redis.offsetMs = 1500;
    expect(await store.getStreamIdForEventId?.(cursor)).toBe('s1');
  });

  it('keeps history forever when ttlMs is Infinity', async () => {
    const redis = new FakeRedis();
    const store = createRedisEventStore(redis, { ttlMs: Infinity });
    const cursor = await store.storeEvent('s1', message);
    expect(redis.ttlOf('mcpose:events:s1')).toBeUndefined();
    redis.offsetMs = 10 * 365 * 24 * 60 * 60 * 1000;
    expect(await store.getStreamIdForEventId?.(cursor)).toBe('s1');
  });

  it('rejects a non-positive ttlMs at construction', () => {
    expect(() => createRedisEventStore(new FakeRedis(), { ttlMs: 0 })).toThrow(
      /ttlMs must be > 0/,
    );
    expect(() =>
      createRedisEventStore(new FakeRedis(), { ttlMs: NaN }),
    ).toThrow(/ttlMs must be > 0/);
  });

  it('treats an event id with a malformed escape as unknown', async () => {
    const store = createRedisEventStore(new FakeRedis());
    expect(await store.getStreamIdForEventId?.('%E0%A4%A:1-0')).toBeUndefined();
    expect(await store.getStreamIdForEventId?.('trailing:')).toBeUndefined();
  });

  it('replays nothing when the cursor entry was trimmed but the stream lives', async () => {
    const redis = new FakeRedis();
    const store = createRedisEventStore(redis);
    await store.storeEvent('s1', message);
    await store.storeEvent('s1', message);
    const sent: JSONRPCMessage[] = [];
    const streamId = await store.replayEventsAfter('s1:0-0', {
      send: async (_id, m) => {
        sent.push(m);
      },
    });
    expect(streamId).toBe('');
    expect(sent).toEqual([]);
  });

  it('skips a stream entry that lost its payload field', async () => {
    const redis = new FakeRedis();
    const store = createRedisEventStore(redis);
    const cursor = await store.storeEvent('s1', message);
    await redis.xAdd('mcpose:events:s1', '*', { unexpected: 'field' });
    const sent: JSONRPCMessage[] = [];
    const streamId = await store.replayEventsAfter(cursor, {
      send: async (_id, m) => {
        sent.push(m);
      },
    });
    expect(streamId).toBe('s1');
    expect(sent).toEqual([]);
  });
});

describeSessionRegistryContract('redis (fake client)', async () =>
  createRedisSessionRegistry(new FakeRedis()),
);

describe('createRedisSessionRegistry()', () => {
  const record = {
    initialize: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'c', version: '1' },
    },
  };

  it('accepts a live node-redis client with no cast', () => {
    const asClient = (c: RedisClientType): RedisSessionRegistryClient => c;
    expect(asClient).toBeTypeOf('function');
  });

  it('keys records by session id under the default prefix', async () => {
    const redis = new FakeRedis();
    await createRedisSessionRegistry(redis).set('s1', record);
    expect(redis.keys()).toEqual(['mcpose:sessions:s1']);
  });

  it('honours a custom key prefix', async () => {
    const redis = new FakeRedis();
    await createRedisSessionRegistry(redis, { keyPrefix: 'tenant-a:' }).set(
      's1',
      record,
    );
    expect(redis.keys()).toEqual(['tenant-a:s1']);
  });

  it('expires the key at the deadline, rounded up to a whole millisecond', async () => {
    const redis = new FakeRedis();
    const registry = createRedisSessionRegistry(redis);
    const expiresAt = Date.now() + 1000.4;
    await registry.set('s1', { ...record, expiresAt });
    expect(redis.ttlOf('mcpose:sessions:s1')).toBe(
      Math.ceil(expiresAt) - Date.now(),
    );
    redis.offsetMs = 1001;
    expect(await registry.get('s1')).toBeUndefined();
  });

  it('clears an earlier deadline when a record is rewritten without one', async () => {
    const redis = new FakeRedis();
    const registry = createRedisSessionRegistry(redis);
    await registry.set('s1', { ...record, expiresAt: Date.now() + 1000 });
    await registry.set('s1', record);
    redis.offsetMs = 10_000;
    expect(await registry.get('s1')).toEqual(record);
  });
});

const redisUrl = process.env['MCPOSE_REDIS_URL'];

// Opt-in lane against a real server: `MCPOSE_REDIS_URL=redis://localhost:6379
// pnpm --filter @mcpose/store-redis test`. Skipped, not failed, when unset.
describe.skipIf(!redisUrl)(
  'createRedisEventStore() against a live Redis',
  () => {
    let client: RedisEventStoreClient & { quit(): Promise<unknown> };
    let run = 0;

    beforeAll(async () => {
      const { createClient } = await import('redis');
      client = createClient(redisUrl === undefined ? {} : { url: redisUrl });
      await (client as unknown as { connect(): Promise<unknown> }).connect();
    });
    afterAll(async () => {
      await client.quit();
    });

    describeEventStoreContract('redis (live server)', async () =>
      // A fresh prefix per case keeps the suite independent of leftovers, and
      // the short TTL lets the server reap them without an explicit cleanup.
      createRedisEventStore(client, {
        keyPrefix: `mcpose-test:${String(process.pid)}:${String(run++)}:`,
        ttlMs: 60_000,
      }),
    );

    describeSessionRegistryContract('redis (live server)', async () =>
      createRedisSessionRegistry(
        client as unknown as RedisSessionRegistryClient,
        { keyPrefix: `mcpose-test:${String(process.pid)}:${String(run++)}:` },
      ),
    );
  },
);
