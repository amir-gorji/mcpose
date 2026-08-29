import { describe, it, expect, vi } from 'vitest';
import { createProxyServer, startHttpProxy } from '../core.js';
import type {
  PromptMiddleware,
  ResourceMiddleware,
  ToolMiddleware,
} from '../core.js';
import {
  DELEGATION_META_KEY,
  detectDelegationLoop,
  serializeDelegationChain,
} from '../delegation.js';
import type { Identity } from '../identity.js';
import { markPassThroughObserver } from '../middleware.js';
import { createProxyContext, type ProxyContext } from '../proxyContext.js';
import type { BackendClient } from '../backendClient.js';
import { getPort, closeServer } from './_helpers.js';

// ── Test helpers ────────────────────────────────────────────────────────────

const AGENT_A = { sub: 'agent-a', type: 'agent' } as const;

function wire(chain: ReadonlyArray<Record<string, unknown>>): {
  v: number;
  chain: ReadonlyArray<Record<string, unknown>>;
} {
  return { v: 1, chain };
}

function metaWith(payload: unknown): Record<string, unknown> {
  return { progressToken: 7, [DELEGATION_META_KEY]: payload };
}

function makeMockBackend(): BackendClient {
  return {
    getServerCapabilities: vi
      .fn()
      .mockReturnValue({ tools: {}, resources: {}, prompts: {} }),
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

/** Invokes a registered handler directly — the stdio path, no transport. */
async function invokeHandler(
  server: ReturnType<typeof createProxyServer>,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const { _requestHandlers: handlers } = server as unknown as {
    _requestHandlers: Map<
      string,
      (
        req: { method: string; params: Record<string, unknown> },
        extra: object,
      ) => Promise<unknown>
    >;
  };
  const handler = handlers.get(method);
  if (!handler) throw new Error(`No handler registered for method: ${method}`);
  return handler({ method, params }, {});
}

function forwardedParams(mock: unknown): Record<string, unknown> {
  return (mock as { mock: { calls: [Record<string, unknown>][] } }).mock
    .calls[0]![0];
}

function forwardedChain(mock: unknown): unknown {
  const meta = forwardedParams(mock)._meta as
    Record<string, unknown> | undefined;
  return meta?.[DELEGATION_META_KEY];
}

const PROXY_B_CALLER: Identity = {
  sub: 'proxy-b-caller',
  type: 'agent',
  roles: ['reader'],
  claims: { tenant: 'bank' },
  resolvedAt: '2026-08-29T10:00:00.000Z',
  source: 'jwt',
};

interface JsonRpcResponse {
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: { rejectionReason?: string };
  };
}

/**
 * Starts an HTTP proxy resolving `identity` for every session, initializes one
 * session, and returns a `call` for JSON-RPC requests on it. The HTTP path is
 * the only one that resolves an identity, which the loop check needs.
 */
async function startProxyWithIdentity(
  backend: BackendClient,
  identity: Identity | undefined,
  options: Partial<Parameters<typeof createProxyServer>[1]> = {},
): Promise<{
  call: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<JsonRpcResponse>;
  close: () => Promise<void>;
}> {
  const server = await startHttpProxy(
    backend,
    { name: 'test-server', ...options },
    {
      port: 0,
      path: '/mcp',
      ...(identity === undefined ? {} : { resolveIdentity: () => identity }),
    },
  );
  const url = `http://localhost:${getPort(server)}/mcp`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });

  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'proxy-a', version: '0.0.1' },
    },
  });
  const sessionHeaders = {
    'mcp-session-id': init.headers.get('mcp-session-id')!,
  };
  await init.text();
  await post(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    sessionHeaders,
  ).then((r) => r.text());

  let id = 1;
  return {
    call: async (method, params) => {
      id += 1;
      const res = await post(
        { jsonrpc: '2.0', id, method, params },
        sessionHeaders,
      );
      const body = await res.text();
      // The transport answers on an SSE stream: one `data:` line per message.
      const payload = body.startsWith('{')
        ? body
        : (/^data: (.*)$/m.exec(body)?.[1] ?? '{}');
      return JSON.parse(payload) as JsonRpcResponse;
    },
    close: () => closeServer(server),
  };
}

/** Captures the context the innermost middleware saw. */
function observer(): { middleware: ToolMiddleware; seen: ProxyContext[] } {
  const seen: ProxyContext[] = [];
  const middleware: ToolMiddleware = async (req, next, context) => {
    seen.push(context);
    return next(req);
  };
  return { middleware, seen };
}

// ── Extraction ──────────────────────────────────────────────────────────────

describe('delegation extraction', () => {
  it('populates delegatedFrom from params._meta before the strip runs', async () => {
    const backend = makeMockBackend();
    const { middleware, seen } = observer();
    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [middleware],
    });

    await invokeHandler(server, 'tools/call', {
      name: 't',
      arguments: {},
      _meta: metaWith(wire([AGENT_A, { sub: 'agent-b', type: 'agent' }])),
    });

    expect(seen[0]?.delegatedFrom?.map((i) => i.sub)).toEqual([
      'agent-a',
      'agent-b',
    ]);
  });

  it('leaves delegatedFrom unset when no payload is present', async () => {
    const backend = makeMockBackend();
    const { middleware, seen } = observer();
    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [middleware],
    });

    await invokeHandler(server, 'tools/call', { name: 't', arguments: {} });

    expect(seen[0]?.delegatedFrom).toBeUndefined();
  });

  it('leaves delegatedFrom unset when the presented chain is empty', async () => {
    const backend = makeMockBackend();
    const { middleware, seen } = observer();
    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [middleware],
    });

    await invokeHandler(server, 'tools/call', {
      name: 't',
      arguments: {},
      _meta: metaWith(wire([])),
    });

    expect(seen[0]?.delegatedFrom).toBeUndefined();
  });

  it('drops roles and claims asserted on the wire', async () => {
    const backend = makeMockBackend();
    const { middleware, seen } = observer();
    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [middleware],
    });

    await invokeHandler(server, 'tools/call', {
      name: 't',
      arguments: {},
      _meta: metaWith(
        wire([
          {
            sub: 'agent-a',
            type: 'agent',
            roles: ['admin'],
            claims: { tenant: 'other-bank' },
          },
        ]),
      ),
    });

    const extracted = seen[0]?.delegatedFrom?.[0];
    expect(extracted?.sub).toBe('agent-a');
    expect(extracted?.roles).toEqual([]);
    expect(extracted?.claims).toEqual({});
  });

  it('keeps a valid source, displayName, and resolvedAt', async () => {
    const backend = makeMockBackend();
    const { middleware, seen } = observer();
    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [middleware],
    });

    await invokeHandler(server, 'tools/call', {
      name: 't',
      arguments: {},
      _meta: metaWith(
        wire([
          {
            sub: 'agent-a',
            type: 'agent',
            displayName: 'Agent A',
            source: 'jwt',
            resolvedAt: '2026-08-29T10:00:00.000Z',
          },
        ]),
      ),
    });

    expect(seen[0]?.delegatedFrom?.[0]).toMatchObject({
      displayName: 'Agent A',
      source: 'jwt',
      resolvedAt: '2026-08-29T10:00:00.000Z',
    });
  });

  it('replaces an unknown source and an unparseable resolvedAt', async () => {
    const backend = makeMockBackend();
    const { middleware, seen } = observer();
    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [middleware],
    });
    const before = new Date().toISOString();

    await invokeHandler(server, 'tools/call', {
      name: 't',
      arguments: {},
      _meta: metaWith(
        wire([
          {
            sub: 'agent-a',
            type: 'agent',
            displayName: 42,
            source: 'homegrown',
            resolvedAt: 'last tuesday',
          },
        ]),
      ),
    });

    const extracted = seen[0]?.delegatedFrom?.[0];
    expect(extracted?.source).toBe('custom');
    expect(extracted?.displayName).toBeUndefined();
    // The receipt time stands in for a timestamp the proxy cannot read.
    expect(extracted?.resolvedAt.localeCompare(before)).toBeGreaterThanOrEqual(
      0,
    );
  });

  it.each([
    ['2026-08-29T10:00:00.000Z', true],
    ['2026-08-29T10:00:00Z', true],
    ['2026-08-29T12:00:00+02:00', true],
    // ISO-shaped but not a real instant, so it is not a timestamp.
    ['2026-13-45T10:00:00Z', false],
    ['2026-08-29', false],
    ['29 August 2026', false],
  ] as const)('keeps resolvedAt %s: %s', async (resolvedAt, kept) => {
    const backend = makeMockBackend();
    const { middleware, seen } = observer();
    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [middleware],
    });

    await invokeHandler(server, 'tools/call', {
      name: 't',
      arguments: {},
      _meta: metaWith(wire([{ sub: 'agent-a', type: 'agent', resolvedAt }])),
    });

    const extracted = seen[0]?.delegatedFrom?.[0];
    expect(extracted?.resolvedAt === resolvedAt).toBe(kept);
  });

  it('extracts on a resource read and on a prompt get', async () => {
    const backend = makeMockBackend();
    const promptSeen: ProxyContext[] = [];
    const resourceSeen: ProxyContext[] = [];
    const promptObserver: PromptMiddleware = async (req, next, context) => {
      promptSeen.push(context);
      return next(req);
    };
    const resourceObserver: ResourceMiddleware = async (req, next, context) => {
      resourceSeen.push(context);
      return next(req);
    };
    const server = createProxyServer(backend, {
      name: 'test-server',
      resourceMiddleware: [resourceObserver],
      promptMiddleware: [promptObserver],
    });
    const _meta = metaWith(wire([AGENT_A]));

    await invokeHandler(server, 'resources/read', { uri: 'res://a', _meta });
    await invokeHandler(server, 'prompts/get', { name: 'p', _meta });

    expect(resourceSeen[0]?.delegatedFrom?.[0]?.sub).toBe('agent-a');
    expect(promptSeen[0]?.delegatedFrom?.[0]?.sub).toBe('agent-a');
  });

  it('extracts on the mesh tool-call path', async () => {
    const backend = makeMockBackend();
    const { middleware, seen } = observer();
    const server = createProxyServer(
      { a: backend },
      { name: 'test-server', toolMiddleware: [middleware] },
    );

    await invokeHandler(server, 'tools/call', {
      name: 'a__t',
      arguments: {},
      _meta: metaWith(wire([AGENT_A])),
    });

    expect(seen[0]?.delegatedFrom?.[0]?.sub).toBe('agent-a');
  });

  it('lets a host chain stamped in middleware win downstream', async () => {
    const backend = makeMockBackend();
    const hostChain: Identity[] = [
      {
        sub: 'host-stamped',
        type: 'service',
        roles: [],
        claims: {},
        resolvedAt: '2026-08-29T10:00:00.000Z',
        source: 'custom',
      },
    ];
    const stamp: ToolMiddleware = async (req, next, context) => {
      context.delegatedFrom = hostChain;
      return next(req);
    };
    const { middleware, seen } = observer();
    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [stamp, middleware],
    });

    await invokeHandler(server, 'tools/call', {
      name: 't',
      arguments: {},
      _meta: metaWith(wire([AGENT_A])),
    });

    expect(seen[0]?.delegatedFrom).toBe(hostChain);
    expect(forwardedChain(backend.callTool)).toEqual({
      v: 1,
      chain: [
        {
          sub: 'host-stamped',
          type: 'service',
          resolvedAt: '2026-08-29T10:00:00.000Z',
          source: 'custom',
        },
      ],
    });
  });
});

// ── Malformed payloads ──────────────────────────────────────────────────────

describe('delegation rejection', () => {
  const malformed: ReadonlyArray<readonly [string, unknown, string]> = [
    ['a payload that is not an object', 'agent-a', 'payload is not an object'],
    ['an unknown version', { v: 2, chain: [AGENT_A] }, 'unsupported version 2'],
    [
      'a chain that is not an array',
      { v: 1, chain: { sub: 'agent-a' } },
      'chain is not an array',
    ],
    [
      'more than 32 entries',
      wire(
        Array.from({ length: 33 }, (_, i) => ({
          sub: `agent-${i}`,
          type: 'agent',
        })),
      ),
      'chain exceeds 32 entries',
    ],
    [
      'an entry that is not an object',
      wire(['agent-a' as never]),
      'an entry is not an object',
    ],
    ['an entry with no sub', wire([{ type: 'agent' }]), 'an entry has no sub'],
    [
      'an entry with an empty sub',
      wire([{ sub: '', type: 'agent' }]),
      'an entry has no sub',
    ],
    [
      'an entry with a non-string sub',
      wire([{ sub: 7, type: 'agent' }]),
      'an entry has no sub',
    ],
    [
      'an entry with a type outside the union',
      wire([{ sub: 'a', type: 'bot' }]),
      'entry "a" has an unknown type',
    ],
  ];

  it.each(malformed)(
    'rejects %s inside the pipeline',
    async (_case, payload, detail) => {
      const backend = makeMockBackend();
      const { middleware, seen } = observer();
      const server = createProxyServer(backend, {
        name: 'test-server',
        toolMiddleware: [middleware],
      });

      await expect(
        invokeHandler(server, 'tools/call', {
          name: 't',
          arguments: {},
          _meta: metaWith(payload),
        }),
      ).rejects.toMatchObject({
        code: -32600, // ErrorCode.InvalidRequest
        message: `MCP error -32600: Invalid delegation chain: ${detail}`,
        data: { rejectionReason: 'DELEGATION_INVALID' },
      });

      // Observed in-chain, so an audit middleware records the attempt, and
      // the backend never saw the call.
      expect(seen).toHaveLength(1);
      expect(backend.callTool).not.toHaveBeenCalled();
    },
  );

  it('accepts exactly 32 entries', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { name: 'test-server' });

    await invokeHandler(server, 'tools/call', {
      name: 't',
      arguments: {},
      _meta: metaWith(
        wire(
          Array.from({ length: 32 }, (_, i) => ({
            sub: `agent-${i}`,
            type: 'agent',
          })),
        ),
      ),
    });

    expect(backend.callTool).toHaveBeenCalledTimes(1);
  });

  it('rejects a hidden tool call on the malformed chain, not on the tool', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      name: 'test-server',
      hiddenTools: ['t'],
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 't',
        arguments: {},
        _meta: metaWith({ v: 9 }),
      }),
    ).rejects.toMatchObject({
      data: { rejectionReason: 'DELEGATION_INVALID' },
    });
  });

  it.each([
    ['resources/read', { uri: 'res://a' }],
    ['prompts/get', { name: 'p' }],
    ['tools/list', {}],
    ['resources/list', {}],
    ['prompts/list', {}],
  ] as const)('rejects a malformed chain on %s', async (method, params) => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { name: 'test-server' });

    await expect(
      invokeHandler(server, method, {
        ...params,
        _meta: metaWith({ v: 2, chain: [] }),
      }),
    ).rejects.toMatchObject({
      data: { rejectionReason: 'DELEGATION_INVALID' },
    });
  });

  it('rejects a malformed chain on a pass-through resource', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      name: 'test-server',
      passThroughResources: ['res://a'],
    });

    await expect(
      invokeHandler(server, 'resources/read', {
        uri: 'res://a',
        _meta: metaWith({ v: 2, chain: [] }),
      }),
    ).rejects.toMatchObject({
      data: { rejectionReason: 'DELEGATION_INVALID' },
    });
    expect(backend.readResource).not.toHaveBeenCalled();
  });

  it('still observes the rejection for a pass-through tool', async () => {
    const backend = makeMockBackend();
    const { middleware, seen } = observer();
    const server = createProxyServer(backend, {
      name: 'test-server',
      passThroughTools: ['t'],
      toolMiddleware: [markPassThroughObserver(middleware)],
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 't',
        arguments: {},
        _meta: metaWith({ v: 2, chain: [] }),
      }),
    ).rejects.toMatchObject({
      data: { rejectionReason: 'DELEGATION_INVALID' },
    });
    expect(seen).toHaveLength(1);
  });
});

// ── Outbound re-attachment ──────────────────────────────────────────────────

describe('outbound delegation', () => {
  it('re-attaches the chain core can vouch for, not the caller copy', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { name: 'test-server' });

    await invokeHandler(server, 'tools/call', {
      name: 't',
      arguments: {},
      _meta: metaWith(
        wire([{ sub: 'agent-a', type: 'agent', roles: ['admin'] }]),
      ),
    });

    const meta = forwardedParams(backend.callTool)._meta as Record<
      string,
      unknown
    >;
    // The inbound strip removed the caller's `_meta`; what the backend sees
    // is core's rebuilt copy and nothing else.
    expect(Object.keys(meta)).toEqual([DELEGATION_META_KEY]);
    expect(meta[DELEGATION_META_KEY]).toMatchObject({
      v: 1,
      chain: [{ sub: 'agent-a', type: 'agent' }],
    });
    expect(
      (meta[DELEGATION_META_KEY] as { chain: Record<string, unknown>[] })
        .chain[0],
    ).not.toHaveProperty('roles');
  });

  it('attaches nothing when there is no chain and no identity', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { name: 'test-server' });

    await invokeHandler(server, 'tools/call', { name: 't', arguments: {} });

    expect(forwardedParams(backend.callTool)).not.toHaveProperty('_meta');
  });

  it.each([
    ['resources/read', { uri: 'res://a' }, 'readResource'],
    ['prompts/get', { name: 'p' }, 'getPrompt'],
    ['tools/list', {}, 'listTools'],
    ['resources/list', {}, 'listResources'],
    ['prompts/list', {}, 'listPrompts'],
  ] as const)('attaches on %s', async (method, params, backendMethod) => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { name: 'test-server' });

    await invokeHandler(server, method, {
      ...params,
      _meta: metaWith(wire([AGENT_A])),
    });

    expect(forwardedChain(backend[backendMethod])).toMatchObject({
      v: 1,
      chain: [{ sub: 'agent-a' }],
    });
  });

  it('attaches on both mesh routes', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer({ a: backend }, { name: 'test-server' });
    const _meta = metaWith(wire([AGENT_A]));

    await invokeHandler(server, 'tools/call', {
      name: 'a__t',
      arguments: {},
      _meta,
    });
    await invokeHandler(server, 'prompts/get', { name: 'a__p', _meta });
    await invokeHandler(server, 'tools/list', { _meta });

    expect(forwardedChain(backend.callTool)).toMatchObject({
      chain: [{ sub: 'agent-a' }],
    });
    expect(forwardedChain(backend.getPrompt)).toMatchObject({
      chain: [{ sub: 'agent-a' }],
    });
    expect(forwardedChain(backend.listTools)).toMatchObject({
      chain: [{ sub: 'agent-a' }],
    });
  });

  it('leaves a local tool handler to attach its own chain', async () => {
    const backend = makeMockBackend();
    const handler = vi.fn().mockResolvedValue({ content: [] });
    const server = createProxyServer(backend, {
      name: 'test-server',
      localTools: [
        {
          tool: { name: 'local', inputSchema: { type: 'object' as const } },
          handler,
        },
      ],
    });

    await invokeHandler(server, 'tools/call', {
      name: 'local',
      arguments: {},
      _meta: metaWith(wire([AGENT_A])),
    });

    // The handler receives the chain on the context (ADR-0011); core does
    // not rewrite params it is not forwarding.
    const [params, context] = handler.mock.calls[0] as [
      Record<string, unknown>,
      ProxyContext,
    ];
    expect(params).not.toHaveProperty('_meta');
    expect(context.delegatedFrom?.[0]?.sub).toBe('agent-a');
  });

  it('preserves a _meta key middleware added deliberately', async () => {
    const backend = makeMockBackend();
    const addMeta: ToolMiddleware = async (req, next) =>
      next({
        ...req,
        params: { ...req.params, _meta: { tenant: 'bank-pilot' } },
      });
    const server = createProxyServer(backend, {
      name: 'test-server',
      toolMiddleware: [addMeta],
    });

    await invokeHandler(server, 'tools/call', {
      name: 't',
      arguments: {},
      _meta: metaWith(wire([AGENT_A])),
    });

    expect(forwardedParams(backend.callTool)._meta).toMatchObject({
      tenant: 'bank-pilot',
      [DELEGATION_META_KEY]: { v: 1 },
    });
  });
});

// ── The chained-proxy round trip ────────────────────────────────────────────

describe('a proxy chained behind another proxy', () => {
  it('forwards the presented chain extended with the identity it resolved', async () => {
    const backend = makeMockBackend();
    const proxy = await startProxyWithIdentity(backend, PROXY_B_CALLER);

    try {
      await proxy.call('tools/call', {
        name: 't',
        arguments: {},
        _meta: metaWith(wire([AGENT_A])),
      });

      // Oldest-first: the chain proxy A presented, extended with the
      // identity this proxy resolved for A itself.
      expect(forwardedChain(backend.callTool)).toMatchObject({
        v: 1,
        chain: [
          { sub: 'agent-a', type: 'agent', source: 'custom' },
          {
            sub: 'proxy-b-caller',
            type: 'agent',
            resolvedAt: '2026-08-29T10:00:00.000Z',
            source: 'jwt',
          },
        ],
      });
      // The resolved identity's roles and claims stay local to this proxy.
      const forwarded = forwardedChain(backend.callTool) as {
        chain: Record<string, unknown>[];
      };
      expect(forwarded.chain[1]).not.toHaveProperty('roles');
      expect(forwarded.chain[1]).not.toHaveProperty('claims');
    } finally {
      await proxy.close();
    }
  });
});

// ── Loops ───────────────────────────────────────────────────────────────────

describe('delegation loop rejection', () => {
  it('rejects a chain the resolved caller already appears in, in-pipeline', async () => {
    const backend = makeMockBackend();
    const { middleware, seen } = observer();
    const proxy = await startProxyWithIdentity(backend, PROXY_B_CALLER, {
      toolMiddleware: [middleware],
    });

    try {
      const res = await proxy.call('tools/call', {
        name: 't',
        arguments: {},
        _meta: metaWith(
          wire([{ sub: 'proxy-b-caller', type: 'agent' }, AGENT_A]),
        ),
      });

      expect(res.error?.code).toBe(-32600);
      expect(res.error?.message).toContain(
        'Invalid delegation chain: the caller "proxy-b-caller" is already in the chain',
      );
      expect(res.error?.data?.rejectionReason).toBe('DELEGATION_INVALID');
      // Observed in-chain with the identity that tripped it, so the audit
      // trail records the attempt.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.identity?.sub).toBe('proxy-b-caller');
      expect(backend.callTool).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });

  it('lets a chain the resolved caller is absent from through', async () => {
    const backend = makeMockBackend();
    const proxy = await startProxyWithIdentity(backend, PROXY_B_CALLER);

    try {
      const res = await proxy.call('tools/call', {
        name: 't',
        arguments: {},
        _meta: metaWith(wire([AGENT_A, { sub: 'agent-c', type: 'agent' }])),
      });

      expect(res.error).toBeUndefined();
      expect(backend.callTool).toHaveBeenCalledTimes(1);
    } finally {
      await proxy.close();
    }
  });

  it('rejects a looping chain on a resource read too', async () => {
    const backend = makeMockBackend();
    const proxy = await startProxyWithIdentity(backend, PROXY_B_CALLER);

    try {
      const res = await proxy.call('resources/read', {
        uri: 'res://a',
        _meta: metaWith(wire([{ sub: 'proxy-b-caller', type: 'agent' }])),
      });

      expect(res.error).toMatchObject({
        data: { rejectionReason: 'DELEGATION_INVALID' },
      });
      expect(backend.readResource).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });

  it('skips the loop check when no identity was resolved', async () => {
    const backend = makeMockBackend();
    const proxy = await startProxyWithIdentity(backend, undefined);

    try {
      // The same chain that loops above: with nothing resolved there is no
      // sub to look for, so only structural validation applies (ADR-0016).
      const res = await proxy.call('tools/call', {
        name: 't',
        arguments: {},
        _meta: metaWith(wire([{ sub: 'proxy-b-caller', type: 'agent' }])),
      });

      expect(res.error).toBeUndefined();
      expect(backend.callTool).toHaveBeenCalledTimes(1);
    } finally {
      await proxy.close();
    }
  });

  it('skips the loop check on stdio', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { name: 'test-server' });

    await invokeHandler(server, 'tools/call', {
      name: 't',
      arguments: {},
      _meta: metaWith(wire([{ sub: 'proxy-b-caller', type: 'agent' }])),
    });

    expect(backend.callTool).toHaveBeenCalledTimes(1);
  });
});

describe('detectDelegationLoop()', () => {
  const identity: Identity = { ...PROXY_B_CALLER };
  const link = (sub: string): Identity => ({ ...PROXY_B_CALLER, sub });

  it.each([
    ['the caller is in the chain', [link('a'), link('proxy-b-caller')], true],
    ['the caller is absent', [link('a'), link('b')], false],
    ['the chain is empty', [], false],
  ] as const)('%s: %s', (_case, delegatedFrom, looped) => {
    const error = detectDelegationLoop(
      createProxyContext({ identity, delegatedFrom: [...delegatedFrom] }),
    );
    expect(error === undefined).toBe(!looped);
  });

  it('returns nothing without a resolved identity, chain or not', () => {
    expect(
      detectDelegationLoop(
        createProxyContext({ delegatedFrom: [link('proxy-b-caller')] }),
      ),
    ).toBeUndefined();
    expect(detectDelegationLoop(createProxyContext())).toBeUndefined();
  });
});

// ── The serializer, for hosts ───────────────────────────────────────────────

describe('serializeDelegationChain()', () => {
  it('drops roles and claims', () => {
    expect(
      serializeDelegationChain([
        {
          sub: 'agent-a',
          type: 'agent',
          displayName: 'Agent A',
          roles: ['admin'],
          claims: { tenant: 'bank' },
          resolvedAt: '2026-08-29T10:00:00.000Z',
          source: 'jwt',
        },
      ]),
    ).toEqual({
      v: 1,
      chain: [
        {
          sub: 'agent-a',
          type: 'agent',
          displayName: 'Agent A',
          resolvedAt: '2026-08-29T10:00:00.000Z',
          source: 'jwt',
        },
      ],
    });
  });

  it('serializes an empty chain to an empty wire chain', () => {
    expect(serializeDelegationChain([])).toEqual({ v: 1, chain: [] });
  });
});
