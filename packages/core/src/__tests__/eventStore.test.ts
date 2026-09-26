import { describe, it, expect, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createInMemoryEventStore, scopeEventStore } from '../eventStore.js';

function msg(id: number): JSONRPCMessage {
  return { jsonrpc: '2.0', method: 'notifications/test', params: { id } };
}

describe('createInMemoryEventStore()', () => {
  it('assigns monotonically increasing event ids', async () => {
    const store = createInMemoryEventStore();
    const a = await store.storeEvent('stream-a', msg(1));
    const b = await store.storeEvent('stream-a', msg(2));
    expect(parseInt(b, 10)).toBeGreaterThan(parseInt(a, 10));
  });

  it('resolves the stream id for a stored event', async () => {
    const store = createInMemoryEventStore();
    const id = await store.storeEvent('stream-a', msg(1));
    expect(await store.getStreamIdForEventId?.(id)).toBe('stream-a');
  });

  describe('replayEventsAfter', () => {
    it('replays only events belonging to the same stream', async () => {
      const store = createInMemoryEventStore();
      const a1 = await store.storeEvent('stream-a', msg(1));
      await store.storeEvent('stream-b', msg(2));
      const a2 = await store.storeEvent('stream-a', msg(3));
      await store.storeEvent('stream-b', msg(4));

      const send = vi.fn().mockResolvedValue(undefined);
      const streamId = await store.replayEventsAfter(a1, { send });

      expect(streamId).toBe('stream-a');
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(a2, msg(3));
    });

    it('replays nothing for an unknown Last-Event-ID', async () => {
      const store = createInMemoryEventStore();
      await store.storeEvent('stream-a', msg(1));
      await store.storeEvent('stream-a', msg(2));

      const send = vi.fn().mockResolvedValue(undefined);
      const streamId = await store.replayEventsAfter('does-not-exist', {
        send,
      });

      expect(streamId).toBe('');
      expect(send).not.toHaveBeenCalled();
    });

    it('replays nothing for a malformed Last-Event-ID', async () => {
      const store = createInMemoryEventStore();
      await store.storeEvent('stream-a', msg(1));

      const send = vi.fn().mockResolvedValue(undefined);
      const streamId = await store.replayEventsAfter('not-a-number', { send });

      expect(streamId).toBe('');
      expect(send).not.toHaveBeenCalled();
    });

    it('replays nothing for an evicted Last-Event-ID', async () => {
      const store = createInMemoryEventStore(2);
      const first = await store.storeEvent('stream-a', msg(1));
      await store.storeEvent('stream-a', msg(2));
      await store.storeEvent('stream-a', msg(3)); // evicts `first`

      const send = vi.fn().mockResolvedValue(undefined);
      const streamId = await store.replayEventsAfter(first, { send });

      expect(streamId).toBe('');
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('evicts FIFO once maxEvents is reached', async () => {
    const store = createInMemoryEventStore(2);
    const first = await store.storeEvent('stream-a', msg(1));
    const second = await store.storeEvent('stream-a', msg(2));
    const third = await store.storeEvent('stream-a', msg(3));

    expect(await store.getStreamIdForEventId?.(first)).toBeUndefined();
    expect(await store.getStreamIdForEventId?.(second)).toBe('stream-a');
    expect(await store.getStreamIdForEventId?.(third)).toBe('stream-a');
  });
});

describe('scopeEventStore()', () => {
  it('namespaces stream ids by session and strips the prefix on the way out', async () => {
    const inner = createInMemoryEventStore();
    const scoped = scopeEventStore(inner, 'session-a');
    const id = await scoped.storeEvent('_GET_stream', msg(1));
    const id2 = await scoped.storeEvent('_GET_stream', msg(2));

    expect(await inner.getStreamIdForEventId?.(id)).toBe(
      'session-a:_GET_stream',
    );
    expect(await scoped.getStreamIdForEventId?.(id)).toBe('_GET_stream');

    const send = vi.fn().mockResolvedValue(undefined);
    expect(await scoped.replayEventsAfter(id, { send })).toBe('_GET_stream');
    expect(send).toHaveBeenCalledWith(id2, msg(2));
  });

  it("treats another session's cursor as unknown and replays nothing (#154)", async () => {
    const inner = createInMemoryEventStore();
    const a = scopeEventStore(inner, 'session-a');
    const b = scopeEventStore(inner, 'session-b');
    const cursor = await a.storeEvent('_GET_stream', msg(1));
    await a.storeEvent('_GET_stream', msg(2));

    expect(await b.getStreamIdForEventId?.(cursor)).toBeUndefined();
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await b.replayEventsAfter(cursor, { send })).toBe('');
    expect(send).not.toHaveBeenCalled();
  });

  it('learns the owner by a silent replay when the store has no getStreamIdForEventId', async () => {
    const inner = createInMemoryEventStore();
    const bare = {
      storeEvent: inner.storeEvent,
      replayEventsAfter: inner.replayEventsAfter,
    };
    const a = scopeEventStore(bare, 'session-a');
    const b = scopeEventStore(bare, 'session-b');
    const cursor = await a.storeEvent('_GET_stream', msg(1));
    const next = await a.storeEvent('_GET_stream', msg(2));

    expect(await a.getStreamIdForEventId?.(cursor)).toBe('_GET_stream');
    expect(await b.getStreamIdForEventId?.(cursor)).toBeUndefined();

    const send = vi.fn().mockResolvedValue(undefined);
    expect(await b.replayEventsAfter(cursor, { send })).toBe('');
    expect(send).not.toHaveBeenCalled();
    expect(await a.replayEventsAfter(cursor, { send })).toBe('_GET_stream');
    expect(send).toHaveBeenCalledWith(next, msg(2));
  });
});
