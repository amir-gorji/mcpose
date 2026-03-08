import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { createBackendClient } from '../backendClient.js';

describe('createBackendClient() URL scheme validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws for file: URLs', async () => {
    await expect(
      createBackendClient({ url: 'file:///etc/passwd' }),
    ).rejects.toThrow('unsupported URL protocol "file:"');
  });

  it('throws for ftp: URLs', async () => {
    await expect(
      createBackendClient({ url: 'ftp://example.com/mcp' }),
    ).rejects.toThrow('unsupported URL protocol "ftp:"');
  });

  it('throws for javascript: URLs', async () => {
    await expect(
      createBackendClient({ url: 'javascript:alert(1)' }),
    ).rejects.toThrow('unsupported URL protocol "javascript:"');
  });

  it('passes for http: URLs', async () => {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    await expect(
      createBackendClient({ url: 'http://localhost:3000/mcp' }),
    ).resolves.toBeDefined();
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: 'http:' }),
    );
  });

  it('passes for https: URLs', async () => {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    await expect(
      createBackendClient({ url: 'https://example.com/mcp' }),
    ).resolves.toBeDefined();
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: 'https:' }),
    );
  });
});
