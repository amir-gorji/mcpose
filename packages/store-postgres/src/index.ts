/**
 * Postgres-backed {@link EventStore} for mcpose's Streamable HTTP transport.
 *
 * @module @mcpose/store-postgres
 */
import type {
  EventStore,
  EventId,
  StreamId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * The slice of a `pg` client this store actually calls. A `Pool`, a
 * `PoolClient`, and a `Client` all satisfy it structurally, and so does a
 * test double.
 */
export interface PostgresEventStoreClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface PostgresEventStoreOptions {
  /**
   * Table holding the events, optionally schema-qualified. Interpolated into
   * SQL, so it is validated as an identifier and rejected otherwise.
   *
   * @default 'mcpose_events'
   */
  table?: string;
  /**
   * How long an event stays replayable, in milliseconds.
   *
   * Defaults to 30 minutes, which is `startHttpProxy`'s `sessionTtlMs`
   * default: history therefore outlives the session it belongs to. Postgres
   * has no native TTL, so this is enforced on read (an expired row is never
   * replayed) and reclaimed by {@link PostgresEventStore.pruneExpired}.
   * Pass `Infinity` to keep history forever.
   *
   * @default 1_800_000
   */
  ttlMs?: number;
  /**
   * Run {@link PostgresEventStore.pruneExpired} in the background once every
   * this many writes, so a host that forgets to schedule pruning still does
   * not grow without bound. `0` disables it.
   *
   * @default 1000
   */
  pruneEveryWrites?: number;
  /**
   * Called when an opportunistic background prune fails. Defaults to
   * `console.error`. A failed prune is never fatal: it only delays reclaiming
   * space, since expiry itself is enforced on read.
   */
  onError?: (err: unknown) => void;
}

export interface PostgresEventStore extends EventStore {
  /**
   * Creates the table and its indexes if they do not exist. Call once at
   * startup, or run the equivalent SQL from the README as a migration. Never
   * runs implicitly on a write.
   */
  init(): Promise<void>;
  /**
   * Deletes every event older than `ttlMs`. Postgres has no native TTL, so
   * schedule this (or a partition drop) to reclaim space.
   *
   * @returns the number of rows deleted.
   */
  pruneExpired(): Promise<number>;
}

/** `startHttpProxy`'s `sessionTtlMs` default. Keep the two in step. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Bare or schema-qualified identifier, unquoted, no funny business. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Largest value `bigserial` can hold; anything above it fails the cast. */
const MAX_BIGINT = 9223372036854775807n;

/**
 * Builds an {@link EventStore} backed by a single Postgres table, giving SSE
 * reconnect replay durable, uncapped, per-stream history instead of the
 * in-memory store's 1000-event cap shared across every stream in the process.
 *
 * Note that this is the storage half of restart and fleet resumability, not
 * the whole of it: mcpose's session registry is still in memory, so a client
 * reconnecting to a restarted proxy is rejected on its `mcp-session-id`
 * before this store is consulted. See the package README.
 *
 * The client must already be connected: connection lifecycle, pooling, TLS,
 * and reconnection stay with the host application, and this store only reads
 * and writes.
 *
 * ```ts
 * import { Pool } from 'pg';
 * import { startHttpProxy } from 'mcpose';
 * import { createPostgresEventStore } from '@mcpose/store-postgres';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const eventStore = createPostgresEventStore(pool);
 * await eventStore.init();
 * setInterval(() => void eventStore.pruneExpired(), 60_000).unref();
 * await startHttpProxy(backends, {}, { eventStore });
 * ```
 */
export function createPostgresEventStore(
  client: PostgresEventStoreClient,
  options: PostgresEventStoreOptions = {},
): PostgresEventStore {
  const table = options.table ?? 'mcpose_events';
  if (!IDENTIFIER.test(table)) {
    throw new Error(
      `@mcpose/store-postgres: table must be a plain SQL identifier, got ${JSON.stringify(table)}`,
    );
  }
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!(ttlMs > 0)) {
    throw new Error(
      `@mcpose/store-postgres: ttlMs must be > 0 or Infinity, got ${String(options.ttlMs)}`,
    );
  }
  const pruneEveryWrites = options.pruneEveryWrites ?? 1000;
  const onError = options.onError ?? console.error;
  const indexBase = table.replace('.', '_');

  // Infinity would be an invalid Date; the epoch keeps every row live.
  const cutoff = (): Date =>
    Number.isFinite(ttlMs) ? new Date(Date.now() - ttlMs) : new Date(0);

  let writes = 0;

  const pruneExpired = async (): Promise<number> => {
    // No RETURNING: a first prune over a neglected table would otherwise ship
    // every deleted id back over the wire just to be counted.
    const result = await client.query(
      `DELETE FROM ${table} WHERE created_at <= $1`,
      [cutoff()],
    );
    return result.rowCount ?? result.rows.length;
  };

  /** Returns the stream id only if the row exists and has not expired. */
  const streamIdFor = async (
    eventId: EventId,
  ): Promise<StreamId | undefined> => {
    // `Last-Event-ID` is client-controlled. A cursor Postgres cannot cast to
    // bigint (non-numeric, or numeric but out of range) makes the query raise,
    // which the transport reports as a 500 instead of the 400 an unknown
    // cursor deserves. Reject it here and call it unknown, exactly as the
    // in-memory store's failed Map lookup does. The length bound also keeps a
    // megabyte of digits out of `BigInt`.
    if (!/^\d{1,19}$/.test(eventId) || BigInt(eventId) > MAX_BIGINT) {
      return undefined;
    }
    const { rows } = await client.query(
      `SELECT stream_id FROM ${table} WHERE event_id = $1 AND created_at > $2`,
      [eventId, cutoff()],
    );
    const streamId = rows[0]?.['stream_id'];
    return typeof streamId === 'string' ? streamId : undefined;
  };

  return {
    async init() {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
           event_id   bigserial PRIMARY KEY,
           stream_id  text NOT NULL,
           message    jsonb NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${indexBase}_stream_idx ON ${table} (stream_id, event_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${indexBase}_created_at_idx ON ${table} (created_at)`,
      );
    },

    pruneExpired,

    async storeEvent(streamId, message) {
      const { rows } = await client.query(
        `INSERT INTO ${table} (stream_id, message) VALUES ($1, $2) RETURNING event_id`,
        [streamId, JSON.stringify(message)],
      );
      // bigserial comes back as a string from pg (int8 is not JS-safe).
      const eventId = String(rows[0]?.['event_id']);
      writes += 1;
      if (pruneEveryWrites > 0 && writes % pruneEveryWrites === 0) {
        pruneExpired().catch(onError);
      }
      return eventId;
    },

    getStreamIdForEventId: streamIdFor,

    async replayEventsAfter(lastEventId, { send }) {
      const streamId = await streamIdFor(lastEventId);
      // Unknown or already-expired cursor: replay nothing rather than the
      // whole stream, matching mcpose's in-memory store.
      if (streamId === undefined) return '';
      const { rows } = await client.query(
        `SELECT event_id, message FROM ${table}
          WHERE stream_id = $1 AND event_id > $2 AND created_at > $3
          ORDER BY event_id`,
        [streamId, lastEventId, cutoff()],
      );
      for (const row of rows) {
        const message = row['message'];
        await send(
          String(row['event_id']),
          // jsonb comes back parsed from pg, but a driver configured with a
          // different type parser can hand back the raw text.
          (typeof message === 'string'
            ? JSON.parse(message)
            : message) as JSONRPCMessage,
        );
      }
      return streamId;
    },
  };
}
