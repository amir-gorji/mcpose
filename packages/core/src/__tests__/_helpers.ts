import * as http from 'node:http';
import { vi } from 'vitest';
import type { BackendClient } from '../backendClient.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

/** Minimal mocked BackendClient suitable for HTTP integration tests. */
export function makeMockBackend(
  overrides: Partial<{
    capabilities: ServerCapabilities;
  }> = {},
): BackendClient {
  return {
    getServerCapabilities: vi.fn().mockReturnValue(
      overrides.capabilities ?? { tools: {}, resources: {}, prompts: {} },
    ),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
    readResource: vi.fn().mockResolvedValue({ contents: [] }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
    setNotificationHandler: vi.fn(),
    removeNotificationHandler: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BackendClient;
}

export function getPort(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Unexpected address');
  return addr.port;
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * POST over a dedicated connection (`agent: false`), bypassing fetch's
 * keep-alive pool. Under fake timers, undici (Node >= 24) hangs when it
 * reuses a pooled connection whose idle window spans faked time — any
 * request sent after `vi.advanceTimersByTimeAsync()` must use this instead
 * of `fetch`.
 */
export function postOnFreshConnection(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(url, { method: 'POST', agent: false, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}
