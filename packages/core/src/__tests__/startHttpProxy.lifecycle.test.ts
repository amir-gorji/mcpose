import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startHttpProxy } from '../core.js';
import {
  makeMockBackend,
  getPort,
  closeServer,
  postOnFreshConnection,
} from './_helpers.js';

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.1' },
  },
});

async function initSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: INIT_BODY,
  });
  const sessionId = res.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

describe('startHttpProxy() session lifecycle', () => {
  describe('TTL expiry', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('fires onSessionClosed exactly once on TTL expiry', async () => {
      const closed: string[] = [];
      const server = await startHttpProxy(
        makeMockBackend(),
        { name: 'test-server' },
        {
          port: 0,
          path: '/mcp',
          sessionTtlMs: 5000,
          onSessionClosed: (id) => closed.push(id),
        },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;

      try {
        const sessionId = await initSession(baseUrl);

        await vi.advanceTimersByTimeAsync(5001);
        expect(closed).toEqual([sessionId]);

        // Session is gone
        const after = await postOnFreshConnection(
          `${baseUrl}/mcp`,
          { ...MCP_HEADERS, 'mcp-session-id': sessionId },
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          }),
        );
        expect(after).toBe(404);

        // No double-fire later
        await vi.advanceTimersByTimeAsync(10_000);
        expect(closed).toEqual([sessionId]);
      } finally {
        await closeServer(server);
      }
    });

    it('does not crash when onSessionClosed throws on TTL expiry', async () => {
      const errors: unknown[] = [];
      const server = await startHttpProxy(
        makeMockBackend(),
        { name: 'test-server' },
        {
          port: 0,
          path: '/mcp',
          sessionTtlMs: 1000,
          onError: (err) => errors.push(err),
          onSessionClosed: () => {
            throw new Error('flush failed');
          },
        },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;

      try {
        const sessionId = await initSession(baseUrl);
        await vi.advanceTimersByTimeAsync(1001);

        // Session torn down despite the throwing hook, error routed to onError
        const after = await postOnFreshConnection(
          `${baseUrl}/mcp`,
          { ...MCP_HEADERS, 'mcp-session-id': sessionId },
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          }),
        );
        expect(after).toBe(404);
        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).message).toBe('flush failed');
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('client DELETE', () => {
    it('fires onSessionClosed once and clears the TTL timer', async () => {
      const closed: string[] = [];
      const server = await startHttpProxy(
        makeMockBackend(),
        { name: 'test-server' },
        {
          port: 0,
          path: '/mcp',
          sessionTtlMs: 60_000,
          onSessionClosed: (id) => closed.push(id),
        },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;

      try {
        const sessionId = await initSession(baseUrl);

        const del = await fetch(`${baseUrl}/mcp`, {
          method: 'DELETE',
          headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
        });
        expect(del.status).toBeLessThan(500);
        expect(closed).toEqual([sessionId]);
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('session-less requests', () => {
    it('rejects a session-less GET with 400 without creating anything', async () => {
      const server = await startHttpProxy(
        makeMockBackend(),
        { name: 'test-server' },
        { port: 0, path: '/mcp' },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;
      try {
        const res = await fetch(`${baseUrl}/mcp`, { method: 'GET' });
        expect(res.status).toBe(400);
      } finally {
        await closeServer(server);
      }
    });

    it('rejects a session-less DELETE with 400', async () => {
      const server = await startHttpProxy(
        makeMockBackend(),
        { name: 'test-server' },
        { port: 0, path: '/mcp' },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;
      try {
        const res = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
        expect(res.status).toBe(400);
      } finally {
        await closeServer(server);
      }
    });

    it('does not leak a session for a session-less non-initialize POST', async () => {
      const server = await startHttpProxy(
        makeMockBackend(),
        { name: 'test-server' },
        { port: 0, path: '/mcp', maxSessions: 1 },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;
      try {
        // Non-initialize body without a session id — transport rejects it,
        // and no session slot may be consumed.
        const bad = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: MCP_HEADERS,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
          }),
        });
        expect(bad.status).toBeGreaterThanOrEqual(400);

        // The single session slot is still available.
        await initSession(baseUrl);
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('maxSessions under concurrency', () => {
    it('never overshoots the cap with concurrent initializes', async () => {
      const maxSessions = 3;
      const server = await startHttpProxy(
        makeMockBackend(),
        { name: 'test-server' },
        {
          port: 0,
          path: '/mcp',
          maxSessions,
          resolveIdentity: async () => {
            // Hold every initialize in-flight long enough that all 10
            // requests overlap.
            await new Promise((r) => setTimeout(r, 100));
            return {
              sub: 'user',
              type: 'human' as const,
              roles: [],
              claims: {},
              resolvedAt: new Date().toISOString(),
              source: 'custom' as const,
            };
          },
        },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;

      try {
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            fetch(`${baseUrl}/mcp`, {
              method: 'POST',
              headers: MCP_HEADERS,
              body: INIT_BODY,
            }),
          ),
        );
        const accepted = results.filter((r) => r.status !== 503);
        const rejected = results.filter((r) => r.status === 503);
        expect(accepted.length).toBeLessThanOrEqual(maxSessions);
        expect(rejected.length).toBeGreaterThanOrEqual(10 - maxSessions);
      } finally {
        await closeServer(server);
      }
    });

    it('returns a JSON body with rejectionReason SESSION_LIMIT on 503', async () => {
      const server = await startHttpProxy(
        makeMockBackend(),
        { name: 'test-server' },
        { port: 0, path: '/mcp', maxSessions: 0 },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;
      try {
        const res = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: MCP_HEADERS,
          body: INIT_BODY,
        });
        expect(res.status).toBe(503);
        const body = (await res.json()) as {
          error: { data: { rejectionReason: string } };
        };
        expect(body.error.data.rejectionReason).toBe('SESSION_LIMIT');
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('validateSession', () => {
    it('rejects a routed request with 401 when validateSession returns false', async () => {
      let allow = true;
      const server = await startHttpProxy(
        makeMockBackend(),
        { name: 'test-server' },
        {
          port: 0,
          path: '/mcp',
          validateSession: () => allow,
        },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;

      try {
        const sessionId = await initSession(baseUrl);
        const listBody = JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        });

        const ok = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
          body: listBody,
        });
        expect(ok.status).not.toBe(401);

        allow = false;
        const denied = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
          body: listBody,
        });
        expect(denied.status).toBe(401);
      } finally {
        await closeServer(server);
      }
    });

    it('treats a throwing validateSession as rejection', async () => {
      const server = await startHttpProxy(
        makeMockBackend(),
        { name: 'test-server' },
        {
          port: 0,
          path: '/mcp',
          validateSession: () => {
            throw new Error('token expired');
          },
        },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;

      try {
        const sessionId = await initSession(baseUrl);
        const res = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          }),
        });
        expect(res.status).toBe(401);
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('header redaction', () => {
    it('strips credential headers from the middleware context', async () => {
      let seenHeaders: Readonly<Record<string, string>> | undefined;
      const server = await startHttpProxy(
        makeMockBackend(),
        {
          name: 'test-server',
          listToolsMiddleware: [
            async (req, next, context) => {
              seenHeaders = context.headers;
              return next(req);
            },
          ],
        },
        { port: 0, path: '/mcp' },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;

      try {
        const sessionId = await initSession(baseUrl);
        await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            ...MCP_HEADERS,
            'mcp-session-id': sessionId,
            authorization: 'Bearer secret-token',
            cookie: 'session=abc',
            'x-api-key': 'key-123',
            'x-tenant-id': 'bank-42',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          }),
        });

        expect(seenHeaders).toBeDefined();
        expect(seenHeaders).not.toHaveProperty('authorization');
        expect(seenHeaders).not.toHaveProperty('cookie');
        expect(seenHeaders).not.toHaveProperty('x-api-key');
        expect(seenHeaders!['x-tenant-id']).toBe('bank-42');
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('server shutdown', () => {
    it('flushes onSessionClosed for active sessions on close()', async () => {
      const closed: string[] = [];
      const server = await startHttpProxy(
        makeMockBackend(),
        { name: 'test-server' },
        {
          port: 0,
          path: '/mcp',
          onSessionClosed: (id) => closed.push(id),
        },
      );
      const baseUrl = `http://localhost:${getPort(server)}`;

      const sessionId = await initSession(baseUrl);
      await closeServer(server);

      expect(closed).toEqual([sessionId]);
      expect(server.listening).toBe(false);
    });
  });
});
