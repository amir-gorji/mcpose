import { describe, it, expect } from 'vitest';
import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { startHttpProxy } from '../core.js';
import { createInMemoryEventStore } from '../eventStore.js';
import { makeMockBackend, getPort, closeServer } from './_helpers.js';

// Priming events (the first `id:` on a resumable stream) are only sent to
// clients that negotiated a protocol version with empty-data SSE support.
const PROTOCOL_VERSION = '2025-11-25';

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

/** Initializes a session and returns the first event id on its response stream. */
async function initSession(
  baseUrl: string,
): Promise<{ sessionId: string; eventId: string }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.1' },
      },
    }),
  });
  const body = await res.text();
  const eventId = /^id: (.+)$/m.exec(body)?.[1];
  expect(eventId).toBeTruthy();
  return { sessionId: res.headers.get('mcp-session-id')!, eventId: eventId! };
}

async function resumeStandaloneStream(
  baseUrl: string,
  sessionId: string,
  lastEventId: string,
): Promise<number> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'last-event-id': lastEventId,
    },
    signal: controller.signal,
  });
  controller.abort();
  return res.status;
}

describe('startHttpProxy() SSE replay is scoped per session (#154)', () => {
  it('namespaces stream ids by session id before they reach the store', async () => {
    const streamIds: string[] = [];
    const inner = createInMemoryEventStore();
    const eventStore: EventStore = {
      ...inner,
      storeEvent(streamId, message) {
        streamIds.push(streamId);
        return inner.storeEvent(streamId, message);
      },
    };
    const server = await startHttpProxy(
      makeMockBackend(),
      { name: 'test-server' },
      { port: 0, path: '/mcp', eventStore },
    );
    const baseUrl = `http://localhost:${getPort(server)}`;
    try {
      const a = await initSession(baseUrl);
      const b = await initSession(baseUrl);
      expect(streamIds.length).toBeGreaterThan(0);
      expect(
        streamIds.every(
          (id) =>
            id.startsWith(`${a.sessionId}:`) ||
            id.startsWith(`${b.sessionId}:`),
        ),
      ).toBe(true);
      expect(streamIds.some((id) => id.startsWith(`${b.sessionId}:`))).toBe(
        true,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("rejects another session's Last-Event-ID and resumes its own", async () => {
    const server = await startHttpProxy(
      makeMockBackend(),
      { name: 'test-server' },
      { port: 0, path: '/mcp' },
    );
    const baseUrl = `http://localhost:${getPort(server)}`;
    try {
      const a = await initSession(baseUrl);
      const b = await initSession(baseUrl);
      expect(
        await resumeStandaloneStream(baseUrl, b.sessionId, a.eventId),
      ).toBe(400);
      expect(
        await resumeStandaloneStream(baseUrl, a.sessionId, a.eventId),
      ).toBe(200);
    } finally {
      await closeServer(server);
    }
  });
});
