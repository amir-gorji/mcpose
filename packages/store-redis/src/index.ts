/**
 * Redis-backed {@link EventStore} for mcpose's Streamable HTTP transport.
 *
 * @module @mcpose/store-redis
 */
import type {
  EventStore,
  EventId,
  StreamId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * The slice of a node-redis client this store actually calls. A live
 * `RedisClientType` satisfies it structurally, and so does a test double.
 *
 * Exclusive `XRANGE` bounds (`(<id>`) need Redis 6.2 or newer.
 */
export interface RedisEventStoreClient {
  xAdd(
    key: string,
    id: string,
    message: Record<string, string>,
  ): Promise<unknown>;
  xRange(
    key: string,
    start: string,
    end: string,
  ): Promise<{ id: string; message: Record<string, string> }[]>;
  pExpire(key: string, ms: number): Promise<unknown>;
}

export interface RedisEventStoreOptions {
  /**
   * Prefix for every key this store writes. One Redis database can host
   * several proxies by giving each its own prefix.
   *
   * @default 'mcpose:events:'
   */
  keyPrefix?: string;
  /**
   * How long a stream's replay history is kept, in milliseconds. Refreshed on
   * every write, so a stream is dropped `ttlMs` after its *last* event.
   *
   * Defaults to 30 minutes, which is `startHttpProxy`'s `sessionTtlMs`
   * default: history therefore outlives the session it belongs to, and is
   * never dropped out from under a live session. Pass `Infinity` to keep
   * history forever (and take on the pruning yourself).
   *
   * @default 1_800_000
   */
  ttlMs?: number;
}

/** `startHttpProxy`'s `sessionTtlMs` default. Keep the two in step. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * The SDK writes a priming event whose message is `{}`, and reads events back
 * by an opaque id it echoes to the client as the SSE `id:` field. Encoding the
 * stream id into that opaque id makes `getStreamIdForEventId` a parse plus one
 * existence check rather than a second index to maintain and expire.
 *
 * `encodeURIComponent` escapes `:`, so the last `:` is always the separator
 * (a Redis stream id is `<ms>-<seq>` and never contains one).
 *
 * `Last-Event-ID` is client-controlled, so the entry id is validated rather
 * than passed through: `XRANGE` raises on anything that is not a stream id,
 * and the transport reports that as a 500 instead of the 400 an unknown
 * cursor deserves. An unparseable cursor is reported as unknown, exactly as
 * the in-memory store's failed Map lookup is.
 */
const ENTRY_ID = /^\d{1,20}-\d{1,20}$/;

function parseEventId(
  eventId: EventId,
): { streamId: StreamId; entryId: string } | undefined {
  const sep = eventId.lastIndexOf(':');
  if (sep <= 0) return undefined;
  const entryId = eventId.slice(sep + 1);
  if (!ENTRY_ID.test(entryId)) return undefined;
  try {
    return { streamId: decodeURIComponent(eventId.slice(0, sep)), entryId };
  } catch {
    // Malformed percent-escape: treat as an unknown cursor.
    return undefined;
  }
}

/**
 * Builds an {@link EventStore} backed by Redis streams, giving SSE reconnect
 * replay durable, uncapped, per-stream history instead of the in-memory
 * store's 1000-event cap shared across every stream in the process.
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
 * import { createClient } from 'redis';
 * import { startHttpProxy } from 'mcpose';
 * import { createRedisEventStore } from '@mcpose/store-redis';
 *
 * const client = createClient({ url: process.env.REDIS_URL });
 * await client.connect();
 * await startHttpProxy(backends, {}, {
 *   eventStore: createRedisEventStore(client),
 * });
 * ```
 *
 * Key layout: one Redis stream per MCP stream id, at
 * `<keyPrefix><streamId>` (default `mcpose:events:<streamId>`).
 */
export function createRedisEventStore(
  client: RedisEventStoreClient,
  options: RedisEventStoreOptions = {},
): EventStore {
  const keyPrefix = options.keyPrefix ?? 'mcpose:events:';
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!(ttlMs > 0)) {
    throw new Error(
      `@mcpose/store-redis: ttlMs must be > 0 or Infinity, got ${String(options.ttlMs)}`,
    );
  }

  const keyFor = (streamId: StreamId): string => `${keyPrefix}${streamId}`;
  const eventIdFor = (streamId: StreamId, entryId: string): EventId =>
    `${encodeURIComponent(streamId)}:${entryId}`;

  return {
    async storeEvent(streamId, message) {
      const key = keyFor(streamId);
      const entryId = await client.xAdd(key, '*', {
        d: JSON.stringify(message),
      });
      if (Number.isFinite(ttlMs)) await client.pExpire(key, ttlMs);
      return eventIdFor(streamId, String(entryId));
    },

    async getStreamIdForEventId(eventId) {
      const parsed = parseEventId(eventId);
      if (!parsed) return undefined;
      const found = await client.xRange(
        keyFor(parsed.streamId),
        parsed.entryId,
        parsed.entryId,
      );
      return found.length > 0 ? parsed.streamId : undefined;
    },

    async replayEventsAfter(lastEventId, { send }) {
      const parsed = parseEventId(lastEventId);
      if (!parsed) return '';
      // Inclusive range, so the first entry doubles as the existence check:
      // one round trip instead of two.
      const entries = await client.xRange(
        keyFor(parsed.streamId),
        parsed.entryId,
        '+',
      );
      // Unknown or already-expired cursor: replay nothing rather than the
      // whole stream, matching mcpose's in-memory store.
      if (entries[0]?.id !== parsed.entryId) return '';
      for (const entry of entries.slice(1)) {
        const payload = entry.message['d'];
        if (payload === undefined) continue;
        await send(
          eventIdFor(parsed.streamId, entry.id),
          JSON.parse(payload) as JSONRPCMessage,
        );
      }
      return parsed.streamId;
    },
  };
}
