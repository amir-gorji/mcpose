/**
 * Conformance suite for the SDK's `EventStore` contract.
 *
 * Every case here is derived from how `StreamableHTTPServerTransport` actually
 * drives the store, not from an adapter's own shape, so the same suite runs
 * against a fake client and against a live server.
 *
 * Kept per-package on purpose: promoting it to a published test util is worth
 * doing once there is a third adapter, not before.
 */
import { describe, it, expect } from 'vitest';
import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const GET_STREAM = '_GET_stream';

/**
 * `Last-Event-ID` is set by the client, so a store must treat every one of
 * these as simply unknown. The in-memory reference store does that for free:
 * a failed `Map` lookup cannot throw. A store that hands a cursor to a backend
 * unvalidated can, and the transport turns the rejection into a 500 rather
 * than the 400 an unknown cursor deserves.
 *
 * Shapes here span both backends on purpose: each adapter must reject the
 * other's plausible-looking ids too.
 */
const HOSTILE_CURSORS = [
  '',
  'nope',
  '../etc/passwd',
  '999999999999999',
  '99999999999999999999', // overflows a Postgres bigserial
  '0',
  '-1',
  '1e3',
  `${GET_STREAM}:notanid`, // Redis-shaped, not a stream id
  `${GET_STREAM}:99-abc`,
  `${GET_STREAM}:-`,
  `${GET_STREAM}:`,
  ':',
  ':1-1',
];

const notification = (n: number): JSONRPCMessage => ({
  jsonrpc: '2.0',
  method: 'notifications/message',
  params: { level: 'info', data: { n, note: 'ünïcode ✓' } },
});

/** Collects what `replayEventsAfter` pushed, the way the transport does. */
async function replay(
  store: EventStore,
  lastEventId: string,
): Promise<{ streamId: string; sent: [string, JSONRPCMessage][] }> {
  const sent: [string, JSONRPCMessage][] = [];
  const streamId = await store.replayEventsAfter(lastEventId, {
    send: async (eventId, message) => {
      sent.push([eventId, message]);
    },
  });
  return { streamId, sent };
}

/**
 * Runs the `EventStore` conformance cases against a store built by `makeStore`.
 * Each case gets a fresh store so ids from one cannot leak into another.
 */
export function describeEventStoreContract(
  name: string,
  makeStore: () => Promise<EventStore>,
): void {
  describe(`EventStore contract: ${name}`, () => {
    it('returns a distinct event id per stored event', async () => {
      const store = await makeStore();
      const ids = [
        await store.storeEvent(GET_STREAM, notification(1)),
        await store.storeEvent(GET_STREAM, notification(2)),
        await store.storeEvent('other-stream', notification(3)),
      ];
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) expect(id).not.toBe('');
    });

    it('maps a stored event id back to its stream', async () => {
      const store = await makeStore();
      const getId = await store.storeEvent(GET_STREAM, notification(1));
      const postId = await store.storeEvent('post-stream', notification(2));
      expect(await store.getStreamIdForEventId?.(getId)).toBe(GET_STREAM);
      expect(await store.getStreamIdForEventId?.(postId)).toBe('post-stream');
    });

    it('reports an unknown or malformed event id as unknown', async () => {
      const store = await makeStore();
      await store.storeEvent(GET_STREAM, notification(1));
      for (const bogus of HOSTILE_CURSORS) {
        expect(await store.getStreamIdForEventId?.(bogus)).toBeUndefined();
      }
    });

    it('replays only the events after the cursor, in order', async () => {
      const store = await makeStore();
      await store.storeEvent(GET_STREAM, notification(1));
      const cursor = await store.storeEvent(GET_STREAM, notification(2));
      await store.storeEvent(GET_STREAM, notification(3));
      await store.storeEvent(GET_STREAM, notification(4));

      const { streamId, sent } = await replay(store, cursor);
      expect(streamId).toBe(GET_STREAM);
      expect(sent.map(([, m]) => m)).toEqual([
        notification(3),
        notification(4),
      ]);
    });

    it('never replays another stream into the resumed one', async () => {
      const store = await makeStore();
      const cursor = await store.storeEvent(GET_STREAM, notification(1));
      await store.storeEvent('post-stream', notification(2));
      await store.storeEvent(GET_STREAM, notification(3));
      await store.storeEvent('post-stream', notification(4));

      const { streamId, sent } = await replay(store, cursor);
      expect(streamId).toBe(GET_STREAM);
      expect(sent.map(([, m]) => m)).toEqual([notification(3)]);
    });

    it('replays nothing when the cursor is the newest event', async () => {
      const store = await makeStore();
      await store.storeEvent(GET_STREAM, notification(1));
      const cursor = await store.storeEvent(GET_STREAM, notification(2));
      const { streamId, sent } = await replay(store, cursor);
      expect(streamId).toBe(GET_STREAM);
      expect(sent).toEqual([]);
    });

    it('replays nothing for an unknown cursor rather than the whole stream', async () => {
      const store = await makeStore();
      await store.storeEvent(GET_STREAM, notification(1));
      await store.storeEvent(GET_STREAM, notification(2));
      for (const bogus of HOSTILE_CURSORS) {
        const { streamId, sent } = await replay(store, bogus);
        expect(streamId).toBe('');
        expect(sent).toEqual([]);
      }
    });

    it('round-trips the SDK priming event, whose message is empty', async () => {
      const store = await makeStore();
      const cursor = await store.storeEvent(GET_STREAM, {} as JSONRPCMessage);
      expect(await store.getStreamIdForEventId?.(cursor)).toBe(GET_STREAM);
      await store.storeEvent(GET_STREAM, {} as JSONRPCMessage);
      const { sent } = await replay(store, cursor);
      expect(sent.map(([, m]) => m)).toEqual([{}]);
    });

    it('hands back event ids that are themselves valid cursors', async () => {
      const store = await makeStore();
      const first = await store.storeEvent(GET_STREAM, notification(1));
      await store.storeEvent(GET_STREAM, notification(2));
      await store.storeEvent(GET_STREAM, notification(3));

      const { sent } = await replay(store, first);
      const nextCursor = sent[0]?.[0];
      expect(nextCursor).toBeDefined();
      expect(await store.getStreamIdForEventId?.(nextCursor!)).toBe(GET_STREAM);
      const second = await replay(store, nextCursor!);
      expect(second.sent.map(([, m]) => m)).toEqual([notification(3)]);
    });

    it('keeps stream ids that are not identifier-shaped intact', async () => {
      const store = await makeStore();
      const weird = 'a:b/c d%2Fe';
      const cursor = await store.storeEvent(weird, notification(1));
      await store.storeEvent(weird, notification(2));
      expect(await store.getStreamIdForEventId?.(cursor)).toBe(weird);
      const { streamId, sent } = await replay(store, cursor);
      expect(streamId).toBe(weird);
      expect(sent.map(([, m]) => m)).toEqual([notification(2)]);
    });
  });
}
