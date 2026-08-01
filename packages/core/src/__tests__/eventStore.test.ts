import { describe, it, expect, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createInMemoryEventStore } from '../eventStore.js';

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
