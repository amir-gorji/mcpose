import type {
  EventStore,
  EventId,
  StreamId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Plug in a persistent event store to support SSE reconnect replay across
 * restarts or load-balanced instances. Re-exports the SDK's `EventStore`
 * interface — any implementation satisfying it is compatible.
 *
 * For single-instance deployments, use {@link createInMemoryEventStore}.
 * For production (multi-instance, HA), implement against Redis or Postgres.
 */
export type { EventStore as PersistentEventStore };

/**
 * In-memory EventStore — default for single-instance deployments.
 * Dropped connections can replay missed notifications on reconnect.
 * Events are evicted FIFO once `maxEvents` is reached.
 */
export function createInMemoryEventStore(maxEvents = 1000): EventStore {
  const store = new Map<
    EventId,
    { streamId: StreamId; message: JSONRPCMessage }
  >();
  let seq = 0;

  return {
    async storeEvent(streamId, message) {
      const id = String(++seq);
      store.set(id, { streamId, message });
      if (store.size > maxEvents) {
        store.delete(store.keys().next().value!);
      }
      return id;
    },

    async getStreamIdForEventId(eventId) {
      return store.get(eventId)?.streamId;
    },

    async replayEventsAfter(lastEventId, { send }) {
      // Unknown or malformed Last-Event-ID (or one already evicted): replay
      // nothing rather than the whole buffer.
      const origin = store.get(lastEventId);
      if (!origin) return '';

      const afterSeq = parseInt(lastEventId, 10);
      for (const [id, { streamId, message }] of store) {
        if (streamId === origin.streamId && parseInt(id, 10) > afterSeq) {
          await send(id, message);
        }
      }
      return origin.streamId;
    },
  };
}

/**
 * Namespaces every stream id by session before it reaches the store.
 *
 * The SDK gives every session's standalone SSE stream the literal id
 * `_GET_stream`, so one store shared by many sessions would otherwise keep
 * their standalone-stream history under one key and a `Last-Event-ID` from
 * one session would replay another's events (#154). Prefixing the stream id
 * with the session id keeps each session's history apart, and a cursor that
 * belongs to another session is reported as unknown, which the transport
 * turns into a 400.
 */
export function scopeEventStore(
  store: EventStore,
  sessionId: string,
): EventStore {
  const prefix = `${sessionId}:`;
  const own = (streamId: StreamId | undefined): StreamId | undefined =>
    streamId?.startsWith(prefix) ? streamId.slice(prefix.length) : undefined;

  return {
    storeEvent: (streamId, message) =>
      store.storeEvent(prefix + streamId, message),

    getStreamIdForEventId: async (eventId) =>
      own(await streamIdOf(store, eventId)),

    async replayEventsAfter(lastEventId, { send }) {
      if (own(await streamIdOf(store, lastEventId)) === undefined) return '';
      return own(await store.replayEventsAfter(lastEventId, { send })) ?? '';
    },
  };
}

// ponytail: a store without `getStreamIdForEventId` (none of ours) is asked
// to replay into a sink once to learn the owner; give it that method if the
// double replay ever matters.
async function streamIdOf(
  store: EventStore,
  eventId: EventId,
): Promise<StreamId | undefined> {
  if (store.getStreamIdForEventId) return store.getStreamIdForEventId(eventId);
  const streamId = await store.replayEventsAfter(eventId, {
    send: async () => undefined,
  });
  return streamId === '' ? undefined : streamId;
}
