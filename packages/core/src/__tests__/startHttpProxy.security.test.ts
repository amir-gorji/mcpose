import { describe, it, expect, vi } from 'vitest';
import * as http from 'node:http';
import { startHttpProxy } from '../core.js';
import { makeMockBackend, getPort, closeServer } from './_helpers.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Initialize POST via raw `http.request`, which (unlike fetch) allows
 * forging the `Host` header — the DNS-rebinding attack this suite verifies.
 */
function rawInitialize(
  port: number,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(INIT_BODY);
  });
}

// ── The default bind ────────────────────────────────────────────────────────

describe('startHttpProxy() — binds loopback by default', () => {
  it('listens on 127.0.0.1 when host is omitted', async () => {
    const server = await startHttpProxy(makeMockBackend(), {}, { port: 0 });
    try {
      const addr = server.address();
      expect(addr).not.toBeNull();
      expect(typeof addr).toBe('object');
      expect((addr as { address: string }).address).toBe('127.0.0.1');
    } finally {
      await closeServer(server);
    }
  });

  it('binds a non-loopback address only when asked to', async () => {
    const server = await startHttpProxy(
      makeMockBackend(),
      {},
      { port: 0, host: '0.0.0.0', onError: () => {} },
    );
    try {
      expect((server.address() as { address: string }).address).toBe('0.0.0.0');
    } finally {
      await closeServer(server);
    }
  });
});

// ── DNS-rebinding protection defaults ───────────────────────────────────────

describe('startHttpProxy() — DNS-rebinding protection defaults to enforcing on loopback', () => {
  it('rejects a forged Host header with 403 by default', async () => {
    const server = await startHttpProxy(makeMockBackend(), {}, { port: 0 });
    try {
      const status = await rawInitialize(getPort(server), {
        host: 'evil.example:1234',
      });
      expect(status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });

  it('accepts the real loopback Host and port by default', async () => {
    const server = await startHttpProxy(makeMockBackend(), {}, { port: 0 });
    try {
      const port = getPort(server);
      expect(await rawInitialize(port, { host: `127.0.0.1:${port}` })).toBe(
        200,
      );
      expect(await rawInitialize(port, { host: `localhost:${port}` })).toBe(
        200,
      );
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a cross-site Origin with 403 and accepts the loopback Origin', async () => {
    const server = await startHttpProxy(makeMockBackend(), {}, { port: 0 });
    try {
      const port = getPort(server);
      expect(
        await rawInitialize(port, {
          host: `127.0.0.1:${port}`,
          origin: 'http://evil.example',
        }),
      ).toBe(403);
      expect(
        await rawInitialize(port, {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
        }),
      ).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it('can be disabled explicitly, restoring the pre-3.0.0 behavior', async () => {
    const server = await startHttpProxy(
      makeMockBackend(),
      {},
      { port: 0, enableDnsRebindingProtection: false },
    );
    try {
      const status = await rawInitialize(getPort(server), {
        host: 'evil.example:1234',
      });
      expect(status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it('defaults to off for a non-loopback bind', async () => {
    const server = await startHttpProxy(
      makeMockBackend(),
      {},
      { port: 0, host: '0.0.0.0', onError: () => {} },
    );
    try {
      const status = await rawInitialize(getPort(server), {
        host: 'evil.example:1234',
      });
      expect(status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });
});

// ── Explicit allowlists are verbatim ────────────────────────────────────────

describe('startHttpProxy() — explicit allowlists are used verbatim, never merged', () => {
  it('an explicit allowedHosts replaces the derived loopback list', async () => {
    const server = await startHttpProxy(
      makeMockBackend(),
      {},
      { port: 0, allowedHosts: ['proxy.internal:8080'] },
    );
    try {
      const port = getPort(server);
      expect(await rawInitialize(port, { host: `127.0.0.1:${port}` })).toBe(
        403,
      );
      expect(await rawInitialize(port, { host: 'proxy.internal:8080' })).toBe(
        200,
      );
    } finally {
      await closeServer(server);
    }
  });
});

// ── The non-loopback warning ────────────────────────────────────────────────

describe('startHttpProxy() — non-loopback bind without resolveIdentity warns once via onError', () => {
  it('reports a startup warning for host 0.0.0.0 without resolveIdentity', async () => {
    const onError = vi.fn();
    const server = await startHttpProxy(
      makeMockBackend(),
      {},
      { port: 0, host: '0.0.0.0', onError },
    );
    try {
      expect(onError).toHaveBeenCalledOnce();
      expect(String(onError.mock.calls[0]?.[0])).toContain('resolveIdentity');
    } finally {
      await closeServer(server);
    }
  });

  it('stays quiet when resolveIdentity is configured', async () => {
    const onError = vi.fn();
    const server = await startHttpProxy(
      makeMockBackend(),
      {},
      {
        port: 0,
        host: '0.0.0.0',
        onError,
        resolveIdentity: () => ({
          sub: 'svc',
          type: 'service',
          roles: [],
          claims: {},
          resolvedAt: new Date().toISOString(),
          source: 'custom',
        }),
      },
    );
    try {
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('warns when protection is explicitly enabled on a non-loopback bind with no allowlists (inert flag)', async () => {
    const onError = vi.fn();
    const server = await startHttpProxy(
      makeMockBackend(),
      {},
      {
        port: 0,
        host: '0.0.0.0',
        enableDnsRebindingProtection: true,
        onError,
        resolveIdentity: () => ({
          sub: 'svc',
          type: 'service',
          roles: [],
          claims: {},
          resolvedAt: new Date().toISOString(),
          source: 'custom',
        }),
      },
    );
    try {
      expect(onError).toHaveBeenCalledOnce();
      expect(String(onError.mock.calls[0]?.[0])).toContain('allowedHosts');
    } finally {
      await closeServer(server);
    }
  });

  it('stays quiet for the default loopback bind', async () => {
    const onError = vi.fn();
    const server = await startHttpProxy(
      makeMockBackend(),
      {},
      { port: 0, onError },
    );
    try {
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });
});
