import type { EventStore, EventId, StreamId } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
  const store = new Map<EventId, { streamId: StreamId; message: JSONRPCMessage }>();
  let seq = 0;

  return {
    async storeEvent(streamId, message) {
      const id = String(++seq) as EventId;
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
      const afterSeq = parseInt(lastEventId as string, 10) || 0;
      let latestStreamId: StreamId = '' as StreamId;
      for (const [id, { streamId, message }] of store) {
        if (parseInt(id as string, 10) > afterSeq) {
          await send(id, message);
          latestStreamId = streamId;
        }
      }
      return latestStreamId;
    },
  };
}
