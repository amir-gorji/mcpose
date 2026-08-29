import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Pool } from 'pg';
import { newDb, type MemoryDbOptions } from 'pg-mem';
import {
  createPostgresEventStore,
  type PostgresEventStore,
  type PostgresEventStoreClient,
} from '../index.js';
import { describeEventStoreContract } from './eventStoreContract.js';

const message = { jsonrpc: '2.0', method: 'ping' } as JSONRPCMessage;

/**
 * pg-mem runs the real SQL in-process, so the fake lane exercises the actual
 * schema and queries rather than a matcher that agrees with itself.
 */
async function memStore(
  options: Parameters<typeof createPostgresEventStore>[1] = {},
  dbOptions: MemoryDbOptions = {},
): Promise<PostgresEventStore> {
  const pg = newDb(dbOptions).adapters.createPg() as {
    Client: new () => PostgresEventStoreClient & {
      connect(): Promise<void>;
    };
  };
  const client = new pg.Client();
  await client.connect();
  const store = createPostgresEventStore(client, options);
  await store.init();
  return store;
}

describeEventStoreContract('postgres (pg-mem)', () => memStore());

describe('createPostgresEventStore()', () => {
  it('accepts a live pg Pool with no cast', () => {
    // If pg reshapes `query`, this stops compiling.
    const asClient = (pool: Pool): PostgresEventStoreClient => pool;
    expect(asClient).toBeTypeOf('function');
  });

  it('is safe to init twice', async () => {
    // A second CREATE ... IF NOT EXISTS short-circuits before pg-mem reads the
    // column AST, which trips its "unread AST" guard; the guard is off here
    // only, so every other case still gets the strict parse.
    const store = await memStore({}, { noAstCoverageCheck: true });
    await expect(store.init()).resolves.toBeUndefined();
  });

  it('never creates the table implicitly on a write', async () => {
    const query = vi.fn(async (_text: string) => ({ rows: [{ event_id: 1 }] }));
    const store = createPostgresEventStore({ query });
    await store.storeEvent('s1', message);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toMatch(/^INSERT INTO mcpose_events/);
  });

  it('refuses a table name that is not a plain identifier', () => {
    const query = vi.fn(async () => ({ rows: [] }));
    for (const table of ['events; DROP TABLE users', '"quoted"', '1bad', '']) {
      expect(() => createPostgresEventStore({ query }, { table })).toThrow(
        /plain SQL identifier/,
      );
    }
    expect(() =>
      createPostgresEventStore({ query }, { table: 'audit.mcpose_events' }),
    ).not.toThrow();
  });

  it('rejects a non-positive ttlMs at construction', () => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect(() => createPostgresEventStore({ query }, { ttlMs: 0 })).toThrow(
      /ttlMs must be > 0/,
    );
    expect(() => createPostgresEventStore({ query }, { ttlMs: NaN })).toThrow(
      /ttlMs must be > 0/,
    );
  });

  it('stops replaying an event once it is older than ttlMs', async () => {
    const store = await memStore({ ttlMs: 1000 });
    const cursor = await store.storeEvent('s1', message);
    await store.storeEvent('s1', message);
    expect(await store.getStreamIdForEventId?.(cursor)).toBe('s1');

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2000);
      expect(await store.getStreamIdForEventId?.(cursor)).toBeUndefined();
      expect(await store.replayEventsAfter(cursor, { send: vi.fn() })).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps history forever when ttlMs is Infinity', async () => {
    const store = await memStore({ ttlMs: Infinity });
    const cursor = await store.storeEvent('s1', message);
    expect(await store.pruneExpired()).toBe(0);
    expect(await store.getStreamIdForEventId?.(cursor)).toBe('s1');
  });

  it('pruneExpired() deletes only the expired rows', async () => {
    const store = await memStore({ ttlMs: 1000 });
    await store.storeEvent('s1', message);
    await store.storeEvent('s1', message);
    expect(await store.pruneExpired()).toBe(0);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2000);
      const fresh = await store.storeEvent('s1', message);
      expect(await store.pruneExpired()).toBe(2);
      expect(await store.getStreamIdForEventId?.(fresh)).toBe('s1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes opportunistically every pruneEveryWrites writes', async () => {
    const store = await memStore({ ttlMs: 1000, pruneEveryWrites: 3 });
    await store.storeEvent('s1', message);
    await store.storeEvent('s1', message);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2000);
      // Third write trips the counter; the prune runs in the background.
      await store.storeEvent('s1', message);
      await vi.waitFor(async () => {
        expect(await store.pruneExpired()).toBe(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed background prune instead of rejecting the write', async () => {
    const onError = vi.fn();
    const query = vi.fn(async (text: string) => {
      if (text.startsWith('DELETE')) throw new Error('connection lost');
      return { rows: [{ event_id: 1 }] };
    });
    const store = createPostgresEventStore(
      { query },
      { pruneEveryWrites: 1, onError },
    );
    await expect(store.storeEvent('s1', message)).resolves.toBe('1');
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  it('parses a message handed back as raw text by a custom type parser', async () => {
    const query = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT stream_id')) {
        return { rows: [{ stream_id: 's1' }] };
      }
      return { rows: [{ event_id: '7', message: JSON.stringify(message) }] };
    });
    const store = createPostgresEventStore({ query });
    const send = vi.fn();
    expect(await store.replayEventsAfter('1', { send })).toBe('s1');
    expect(send).toHaveBeenCalledWith('7', message);
  });
});

const postgresUrl = process.env['MCPOSE_POSTGRES_URL'];

// Opt-in lane against a real server:
// `MCPOSE_POSTGRES_URL=postgres://... pnpm --filter @mcpose/store-postgres test`.
// Skipped, not failed, when unset.
describe.skipIf(!postgresUrl)(
  'createPostgresEventStore() against a live Postgres',
  () => {
    let pool: PostgresEventStoreClient & { end(): Promise<void> };
    let run = 0;

    beforeAll(async () => {
      const { Pool: PgPool } = await import('pg');
      pool = new PgPool({ connectionString: postgresUrl });
    });
    afterAll(async () => {
      await pool.end();
    });

    describeEventStoreContract('postgres (live server)', async () => {
      // A table per case keeps the suite independent of leftovers.
      const table = `mcpose_test_${String(process.pid)}_${String(run++)}`;
      const store = createPostgresEventStore(pool, { table });
      await store.init();
      await pool.query(`TRUNCATE ${table}`);
      return store;
    });
  },
);
