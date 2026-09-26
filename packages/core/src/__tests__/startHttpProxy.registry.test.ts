import { describe, it, expect, vi, afterEach } from 'vitest';
import type * as http from 'node:http';
import type { InitializeRequestParams } from '@modelcontextprotocol/sdk/types.js';
import { startHttpProxy, type HttpProxyOptions } from '../core.js';
import { createInMemoryEventStore } from '../eventStore.js';
import type { SessionRecord, SessionRegistry } from '../sessionRegistry.js';
import type { Identity } from '../identity.js';
import {
  makeMockBackend,
  getPort,
  closeServer,
  postOnFreshConnection,
} from './_helpers.js';

const PROTOCOL_VERSION = '2025-11-25';

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'mcp-protocol-version': PROTOCOL_VERSION,
};

const INIT_PARAMS: InitializeRequestParams = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: { roots: { listChanged: true } },
  clientInfo: { name: 'registry-test', version: '0.0.1' },
};

const LIST_TOOLS = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
});

const IDENTITY: Identity = {
  sub: 'alice',
  type: 'human',
  roles: ['reader'],
  claims: { dept: 'ops', nested: { ok: true } },
  resolvedAt: '2026-01-01T00:00:00.000Z',
  source: 'custom',
};

/** Map-backed registry with call counters, the shape a real adapter fills. */
function fakeRegistry(): SessionRegistry & {
  records: Map<string, SessionRecord>;
  gets: number;
} {
  const records = new Map<string, SessionRecord>();
  return {
    records,
    gets: 0,
    async set(id, record) {
      records.set(id, record);
    },
    async get(id) {
      this.gets += 1;
      return records.get(id);
    },
    async delete(id) {
      records.delete(id);
    },
  };
}

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
      params: INIT_PARAMS,
    }),
  });
  expect(res.status).toBe(200);
  const eventId = /^id: (.+)$/m.exec(await res.text())?.[1];
  return { sessionId: res.headers.get('mcp-session-id')!, eventId: eventId! };
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  vi.useRealTimers();
});

async function start(
  httpOptions: HttpProxyOptions,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = await startHttpProxy(
    makeMockBackend(),
    { name: 'test-server' },
    { port: 0, path: '/mcp', ...httpOptions },
  );
  servers.push(server);
  return { server, baseUrl: `http://localhost:${getPort(server)}` };
}

const listTools = (baseUrl: string, sessionId: string): Promise<number> =>
  postOnFreshConnection(
    `${baseUrl}/mcp`,
    { ...MCP_HEADERS, 'mcp-session-id': sessionId },
    LIST_TOOLS,
  );

describe('startHttpProxy() shared session registry (#155)', () => {
  it('records the initialize params, identity and deadline of a new session', async () => {
    const registry = fakeRegistry();
    const before = Date.now();
    const { baseUrl } = await start({
      sessionRegistry: registry,
      sessionTtlMs: 60_000,
      resolveIdentity: () => IDENTITY,
    });
    const { sessionId } = await initSession(baseUrl);

    const record = registry.records.get(sessionId);
    expect(record?.initialize).toEqual(INIT_PARAMS);
    expect(record?.identity).toEqual(IDENTITY);
    expect(record?.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(record?.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('omits the deadline when sessionTtlMs is Infinity', async () => {
    const registry = fakeRegistry();
    const { baseUrl } = await start({
      sessionRegistry: registry,
      sessionTtlMs: Infinity,
    });
    const { sessionId } = await initSession(baseUrl);
    expect(registry.records.get(sessionId)).not.toHaveProperty('expiresAt');
    expect(registry.records.get(sessionId)).not.toHaveProperty('identity');
  });

  it('does not answer the initialize until the record is persisted', async () => {
    let release: (() => void) | undefined;
    const registry = fakeRegistry();
    registry.set = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const { baseUrl } = await start({ sessionRegistry: registry });

    const pending = fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: INIT_PARAMS,
      }),
    });
    const settled = await Promise.race([
      pending.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 100)),
    ]);
    expect(settled).toBe(false);
    expect(release).toBeDefined();
    release!();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('resumes a session created by a previous process, replay history included', async () => {
    const registry = fakeRegistry();
    const eventStore = createInMemoryEventStore();
    const closedOnA: string[] = [];
    const closedOnB: string[] = [];

    const a = await start({
      sessionRegistry: registry,
      eventStore,
      resolveIdentity: () => IDENTITY,
      onSessionClosed: (id) => closedOnA.push(id),
    });
    const { sessionId, eventId } = await initSession(a.baseUrl);
    await closeServer(a.server);
    servers.splice(servers.indexOf(a.server), 1);
    // Shutdown flushes locally but keeps the shared record.
    expect(closedOnA).toEqual([sessionId]);
    expect(registry.records.has(sessionId)).toBe(true);

    const seen: { sessionId: string; identity?: Identity }[] = [];
    const b = await start({
      sessionRegistry: registry,
      eventStore,
      onSessionClosed: (id) => closedOnB.push(id),
      validateSession: (_req, session) => {
        seen.push(session);
        return true;
      },
    });
    expect(await listTools(b.baseUrl, sessionId)).toBe(200);
    // Identity travels with the record; it is not re-resolved.
    expect(seen[0]).toEqual({ sessionId, identity: IDENTITY });

    const controller = new AbortController();
    const replay = await fetch(`${b.baseUrl}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': PROTOCOL_VERSION,
        'last-event-id': eventId,
      },
      signal: controller.signal,
    });
    controller.abort();
    expect(replay.status).toBe(200);

    await closeServer(b.server);
    servers.splice(servers.indexOf(b.server), 1);
    expect(closedOnB).toEqual([sessionId]);
  });

  it('honours the remaining lifetime of a resumed session, not its own TTL', async () => {
    vi.useFakeTimers();
    const registry = fakeRegistry();
    registry.records.set('s-remaining', {
      initialize: INIT_PARAMS,
      expiresAt: Date.now() + 1000,
    });
    const closed: string[] = [];
    const { baseUrl } = await start({
      sessionRegistry: registry,
      sessionTtlMs: 60_000,
      onSessionClosed: (id) => closed.push(id),
    });

    expect(await listTools(baseUrl, 's-remaining')).toBe(200);
    await vi.advanceTimersByTimeAsync(999);
    expect(closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(closed).toEqual(['s-remaining']);
    // Expiry is final everywhere, so the record goes too.
    expect(registry.records.has('s-remaining')).toBe(false);
    expect(await listTools(baseUrl, 's-remaining')).toBe(404);
  });

  it('treats an expired record as unknown', async () => {
    const registry = fakeRegistry();
    registry.records.set('s-expired', {
      initialize: INIT_PARAMS,
      expiresAt: Date.now() - 1,
    });
    const { baseUrl } = await start({ sessionRegistry: registry });
    expect(await listTools(baseUrl, 's-expired')).toBe(404);
    expect(await listTools(baseUrl, 's-unknown')).toBe(404);
  });

  it('forgets the record on client DELETE', async () => {
    const registry = fakeRegistry();
    const { baseUrl } = await start({ sessionRegistry: registry });
    const { sessionId } = await initSession(baseUrl);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
    });
    expect(res.status).toBe(200);
    expect(registry.records.has(sessionId)).toBe(false);
  });

  it('forgets the record on TTL expiry and reports a failing delete', async () => {
    vi.useFakeTimers();
    const registry = fakeRegistry();
    registry.delete = async () => {
      throw new Error('registry down');
    };
    const errors: unknown[] = [];
    const closed: string[] = [];
    const { baseUrl } = await start({
      sessionRegistry: registry,
      sessionTtlMs: 1000,
      onError: (err) => errors.push(err),
      onSessionClosed: (id) => closed.push(id),
    });
    const { sessionId } = await initSession(baseUrl);
    await vi.advanceTimersByTimeAsync(1001);
    // Teardown still completes: the hook fires and the error is reported.
    expect(closed).toEqual([sessionId]);
    expect((errors[0] as Error).message).toBe('registry down');
  });

  it('coalesces concurrent requests for one unknown session into one resume', async () => {
    const registry = fakeRegistry();
    registry.records.set('s-shared', { initialize: INIT_PARAMS });
    const closed: string[] = [];
    const { server, baseUrl } = await start({
      sessionRegistry: registry,
      onSessionClosed: (id) => closed.push(id),
    });
    const statuses = await Promise.all(
      Array.from({ length: 5 }, () => listTools(baseUrl, 's-shared')),
    );
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    expect(registry.gets).toBe(1);

    await closeServer(server);
    servers.splice(servers.indexOf(server), 1);
    expect(closed).toEqual(['s-shared']);
  });

  it('counts a resumed session against maxSessions', async () => {
    const registry = fakeRegistry();
    registry.records.set('s-extra', { initialize: INIT_PARAMS });
    const { baseUrl } = await start({
      sessionRegistry: registry,
      maxSessions: 1,
    });
    await initSession(baseUrl);
    expect(await listTools(baseUrl, 's-extra')).toBe(503);
    // Nothing was admitted, so the record is untouched for another instance.
    expect(registry.records.has('s-extra')).toBe(true);
  });

  it('fails the initialize and leaks nothing when the record cannot be persisted', async () => {
    const registry = fakeRegistry();
    registry.set = async () => {
      throw new Error('registry down');
    };
    const errors: unknown[] = [];
    const closed: string[] = [];
    const { server, baseUrl } = await start({
      sessionRegistry: registry,
      onError: (err) => errors.push(err),
      onSessionClosed: (id) => closed.push(id),
    });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: INIT_PARAMS,
      }),
    });
    // The SDK owns the response once its hook throws; the real cause goes
    // to onError and the client sees a message that names no backing store.
    expect(res.status).toBe(400);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = await res.text();
    expect(body).toContain('session registry unavailable');
    expect(body).not.toContain('registry down');
    expect((errors[0] as Error).message).toBe('registry down');

    await closeServer(server);
    servers.splice(servers.indexOf(server), 1);
    expect(closed).toEqual([]);
  });

  it('answers 500 when the registry lookup itself fails', async () => {
    const registry = fakeRegistry();
    registry.get = async () => {
      throw new Error('registry down');
    };
    const errors: unknown[] = [];
    const { baseUrl } = await start({
      sessionRegistry: registry,
      onError: (err) => errors.push(err),
    });
    expect(await listTools(baseUrl, 's-any')).toBe(500);
    expect((errors[0] as Error).message).toBe('registry down');
  });

  it('runs validateSession against the stored identity on a resumed request', async () => {
    const registry = fakeRegistry();
    registry.records.set('s-alice', {
      initialize: INIT_PARAMS,
      identity: IDENTITY,
    });
    const seen: (Identity | undefined)[] = [];
    const { baseUrl } = await start({
      sessionRegistry: registry,
      validateSession: (_req, session) => {
        seen.push(session.identity);
        return session.identity?.sub === 'bob';
      },
    });
    expect(await listTools(baseUrl, 's-alice')).toBe(401);
    expect(seen).toEqual([IDENTITY]);
  });

  it("relays the SDK's rejection when the replayed initialize fails its checks", async () => {
    const registry = fakeRegistry();
    registry.records.set('s-host', { initialize: INIT_PARAMS });
    const closed: string[] = [];
    const { server, baseUrl } = await start({
      sessionRegistry: registry,
      enableDnsRebindingProtection: true,
      allowedHosts: ['example.com'],
      onSessionClosed: (id) => closed.push(id),
    });
    // The real request would fail the same Host check, so the client sees
    // the SDK's own answer rather than a 404 or a 500.
    expect(await listTools(baseUrl, 's-host')).toBe(403);
    expect(registry.records.has('s-host')).toBe(true);

    await closeServer(server);
    servers.splice(servers.indexOf(server), 1);
    expect(closed).toEqual([]);
  });
});
