import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth';

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
    const lastUrl = vi.mocked(StreamableHTTPClientTransport).mock.lastCall?.[0];
    expect(lastUrl).toBeInstanceOf(URL);
    expect((lastUrl as URL).protocol).toBe('http:');
  });

  it('passes for https: URLs', async () => {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    await expect(
      createBackendClient({ url: 'https://example.com/mcp' }),
    ).resolves.toBeDefined();
    const lastUrl = vi.mocked(StreamableHTTPClientTransport).mock.lastCall?.[0];
    expect(lastUrl).toBeInstanceOf(URL);
    expect((lastUrl as URL).protocol).toBe('https:');
  });

  it('throws when neither command nor url is provided', async () => {
    await expect(createBackendClient({})).rejects.toThrow(
      'either command or url must be provided',
    );
  });

  it('throws when both command and url are empty strings (both falsy)', async () => {
    await expect(createBackendClient({ command: '', url: '' })).rejects.toThrow(
      'either command or url must be provided',
    );
  });

  it('prefers url over command when both are provided', async () => {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    await expect(
      createBackendClient({
        command: '/definitely/not/an/executable',
        args: ['--bogus'],
        url: 'https://example.com/mcp',
      }),
    ).resolves.toBeDefined();
    const lastUrl = vi.mocked(StreamableHTTPClientTransport).mock.lastCall?.[0];
    expect(lastUrl).toBeInstanceOf(URL);
    expect((lastUrl as URL).protocol).toBe('https:');
  });

  it('normalizes uppercase URL schemes via WHATWG URL parsing', async () => {
    await expect(
      createBackendClient({ url: 'HTTPS://example.com/mcp' }),
    ).resolves.toBeDefined();
  });

  it('accepts URLs with userinfo, query, and fragment on https', async () => {
    await expect(
      createBackendClient({
        url: 'https://user:pass@example.com/mcp?foo=bar#frag',
      }),
    ).resolves.toBeDefined();
  });

  it('throws on a malformed URL string', async () => {
    await expect(
      createBackendClient({ url: 'not a url' }),
    ).rejects.toThrow();
  });
});

describe('createBackendClient() HTTP transport options', () => {
  // A recognizable stand-in for an OAuthClientProvider. createBackendClient only
  // stores the reference, so we assert identity rather than driving a real flow.
  const stubAuthProvider = {
    redirectUrl: 'http://localhost:3000/callback',
  } as unknown as OAuthClientProvider;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Resolves to the options object passed to the last StreamableHTTPClientTransport. */
  const lastTransportOpts = async () => {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    return vi.mocked(StreamableHTTPClientTransport).mock.lastCall?.[1] as
      | {
          requestInit?: { headers?: Record<string, string> };
          authProvider?: OAuthClientProvider;
        }
      | undefined;
  };

  it('forwards custom headers to the HTTP transport via requestInit', async () => {
    const headers = { Authorization: 'Bearer abc', 'X-Trace-Id': '123' };
    await createBackendClient({ url: 'https://example.com/mcp', headers });

    expect((await lastTransportOpts())?.requestInit?.headers).toEqual(headers);
  });

  it('forwards an OAuth authProvider to the HTTP transport', async () => {
    await createBackendClient({
      url: 'https://example.com/mcp',
      authProvider: stubAuthProvider,
    });

    expect((await lastTransportOpts())?.authProvider).toBe(stubAuthProvider);
  });

  it('forwards headers and authProvider together', async () => {
    const headers = { Authorization: 'Bearer t' };
    await createBackendClient({
      url: 'https://example.com/mcp',
      headers,
      authProvider: stubAuthProvider,
    });
    const opts = await lastTransportOpts();

    expect(opts?.requestInit?.headers).toEqual(headers);
    expect(opts?.authProvider).toBe(stubAuthProvider);
  });

  it('omits requestInit and authProvider when neither is configured', async () => {
    await createBackendClient({ url: 'https://example.com/mcp' });
    const opts = await lastTransportOpts();

    expect(opts?.requestInit).toBeUndefined();
    expect(opts?.authProvider).toBeUndefined();
  });
});
