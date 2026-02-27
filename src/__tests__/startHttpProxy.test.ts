import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import { startHttpProxy } from '../core.js';
import type { BackendClient } from '../backendClient.js';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeMockBackend(): BackendClient {
  return {
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
    readResource: vi.fn().mockResolvedValue({ contents: [] }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
    setNotificationHandler: vi.fn(),
  } as unknown as BackendClient;
}

function getPort(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Unexpected address');
  return addr.port;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('startHttpProxy()', () => {
  it('resolves to a listening http.Server', async () => {
    const backend = makeMockBackend();
    const server = await startHttpProxy(backend, {}, { port: 0 });
    try {
      expect(server).toBeInstanceOf(http.Server);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  describe('routing', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      const backend = makeMockBackend();
      server = await startHttpProxy(backend, {}, { port: 0, path: '/mcp' });
      baseUrl = `http://localhost:${getPort(server)}`;
    });

    afterAll(
      () => new Promise<void>((res) => server.close(() => res())),
    );

    it('returns 404 for unknown paths', async () => {
      const res = await fetch(`${baseUrl}/unknown`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('returns 404 for wrong HTTP methods on /mcp', async () => {
      const res = await fetch(`${baseUrl}/mcp`, { method: 'PUT' });
      expect(res.status).toBe(404);
    });

    it('does not return 404 or 500 for a valid MCP initialize POST', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
        },
      });

      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(500);
    });

    it('routes a follow-up POST with mcp-session-id to the existing session', async () => {
      const mcpAccept = 'application/json, text/event-stream';
      const initBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
        },
      });

      // Initialize — server assigns session ID
      const initRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: mcpAccept },
        body: initBody,
      });
      const sessionId = initRes.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      // Follow-up reusing session ID
      const followUpBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      const followUpRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: mcpAccept,
          'mcp-session-id': sessionId!,
        },
        body: followUpBody,
      });

      expect(followUpRes.status).not.toBe(404);
      expect(followUpRes.status).not.toBe(500);
    });

    it('returns 404 for a POST with an unknown mcp-session-id', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'mcp-session-id': 'nonexistent-session-id-12345',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });

      expect(res.status).toBe(404);
    });
  });
});
