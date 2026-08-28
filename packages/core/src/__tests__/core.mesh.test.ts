/** Multi-backend (mesh) composition — ADR-0013. */
import { describe, it, expect, vi } from 'vitest';
import {
  createProxyServer,
  startHttpProxy,
  type PromptMiddleware,
  type ToolMiddleware,
} from '../core.js';
import type { BackendClient } from '../backendClient.js';
import type { TelemetryEvent } from '../telemetry.js';
import { markPassThroughObserver } from '../middleware.js';
import {
  ErrorCode,
  PromptListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type ServerCapabilities,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

// ── Test helpers ────────────────────────────────────────────────────────────

type MockBackend = BackendClient & {
  __notificationHandlers: Map<string, () => Promise<void>>;
};

const tool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
});

function makeMeshBackend(
  toolNames: ReadonlyArray<string>,
  overrides: {
    capabilities?: ServerCapabilities;
    prompts?: ReadonlyArray<string>;
  } = {},
): MockBackend {
  const notificationHandlers = new Map<string, () => Promise<void>>();

  return {
    getServerCapabilities: vi
      .fn<() => ServerCapabilities>()
      .mockReturnValue(overrides.capabilities ?? { tools: {}, prompts: {} }),
    listTools: vi.fn().mockResolvedValue({ tools: toolNames.map(tool) }),
    callTool: vi
      .fn()
      .mockImplementation((params: { name: string }) =>
        Promise.resolve({ content: [{ type: 'text', text: params.name }] }),
      ),
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
    readResource: vi.fn().mockResolvedValue({ contents: [] }),
    listPrompts: vi.fn().mockResolvedValue({
      prompts: (overrides.prompts ?? []).map((name) => ({ name })),
    }),
    getPrompt: vi
      .fn()
      .mockImplementation((params: { name: string }) =>
        Promise.resolve({ messages: [], description: params.name }),
      ),
    setNotificationHandler: vi.fn((schema, handler) => {
      const method =
        schema === ToolListChangedNotificationSchema
          ? 'notifications/tools/list_changed'
          : schema === PromptListChangedNotificationSchema
            ? 'notifications/prompts/list_changed'
            : 'notifications/resources/list_changed';
      notificationHandlers.set(method, handler as () => Promise<void>);
    }),
    removeNotificationHandler: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    __notificationHandlers: notificationHandlers,
  } as unknown as MockBackend;
}

async function invokeHandler(
  server: ReturnType<typeof createProxyServer>,
  method: string,
  params: Record<string, unknown> = {},
  extra: object = {},
) {
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
  return handler({ method, params }, extra);
}

const listToolNames = async (
  server: ReturnType<typeof createProxyServer>,
  params: Record<string, unknown> = {},
): Promise<string[]> => {
  const result = (await invokeHandler(server, 'tools/list', params)) as {
    tools: { name: string }[];
  };
  return result.tools.map((t) => t.name);
};

const advertisedCapabilities = (
  server: ReturnType<typeof createProxyServer>,
): ServerCapabilities =>
  (server as unknown as { _capabilities: ServerCapabilities })._capabilities;

// ── Backend keys ────────────────────────────────────────────────────────────

describe('createProxyServer() — backend key validation', () => {
  it('throws on an empty backends record', () => {
    expect(() => createProxyServer({})).toThrow(/backends record is empty/);
  });

  it('throws on an empty backend key', () => {
    expect(() => createProxyServer({ '': makeMeshBackend([]) })).toThrow(
      /backend key must not be empty/,
    );
  });

  it('throws on a backend key containing the namespace separator', () => {
    expect(() => createProxyServer({ my__crm: makeMeshBackend([]) })).toThrow(
      /must not contain "__"/,
    );
  });

  it('names the offending backend when one is not connected', () => {
    const disconnected = makeMeshBackend([]);
    vi.mocked(disconnected.getServerCapabilities).mockReturnValue(undefined);
    expect(() =>
      createProxyServer({ crm: makeMeshBackend([]), docs: disconnected }),
    ).toThrow(/backend "docs" is not connected/);
  });

  it('validates backend keys at startHttpProxy, before the first session', () => {
    expect(() =>
      startHttpProxy({ a__b: makeMeshBackend([]) }, {}, { port: 0 }),
    ).toThrow(/must not contain "__"/);
  });
});

// ── Namespacing and routing ────────────────────────────────────────────────

describe('createProxyServer() — mesh namespacing', () => {
  it('exposes every backend tool under its backend key', async () => {
    const server = createProxyServer({
      crm: makeMeshBackend(['lookup', 'delete_account']),
      docs: makeMeshBackend(['search']),
    });

    expect(await listToolNames(server)).toEqual([
      'crm__lookup',
      'crm__delete_account',
      'docs__search',
    ]);
  });

  it('routes a call to its backend with the un-namespaced name', async () => {
    const crm = makeMeshBackend(['lookup']);
    const docs = makeMeshBackend(['search']);
    const server = createProxyServer({ crm, docs });

    const result = await invokeHandler(server, 'tools/call', {
      name: 'crm__lookup',
      arguments: { q: 'acme' },
    });

    expect(crm.callTool).toHaveBeenCalledWith(
      { name: 'lookup', arguments: { q: 'acme' } },
      undefined,
      undefined,
    );
    expect(docs.callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ content: [{ text: 'lookup' }] });
  });

  it('splits on the first separator, so an upstream name may contain one', async () => {
    const crm = makeMeshBackend(['find__by__email']);
    const server = createProxyServer({ crm });

    expect(await listToolNames(server)).toEqual(['crm__find__by__email']);
    await invokeHandler(server, 'tools/call', {
      name: 'crm__find__by__email',
      arguments: {},
    });
    expect(crm.callTool).toHaveBeenCalledWith(
      { name: 'find__by__email', arguments: {} },
      undefined,
      undefined,
    );
  });
});

describe('createProxyServer() — mesh unroutable calls', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['an un-namespaced name', 'lookup'],
    ['an unknown backend key', 'billing__lookup'],
    ['an empty upstream name', 'crm__'],
    ['a leading separator', '__lookup'],
  ];

  for (const [label, name] of cases) {
    it(`rejects ${label} with BACKEND_UNROUTABLE`, async () => {
      const crm = makeMeshBackend(['lookup']);
      const server = createProxyServer({ crm });

      await expect(
        invokeHandler(server, 'tools/call', { name, arguments: {} }),
      ).rejects.toMatchObject({
        code: ErrorCode.MethodNotFound,
        data: { rejectionReason: 'BACKEND_UNROUTABLE' },
      });
      expect(crm.callTool).not.toHaveBeenCalled();
    });
  }

  it('rejects a prefix naming a backend without a tools capability', async () => {
    const promptsOnly = makeMeshBackend([], {
      capabilities: { prompts: {} },
      prompts: ['brief'],
    });
    const server = createProxyServer({
      crm: makeMeshBackend(['lookup']),
      wiki: promptsOnly,
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'wiki__brief',
        arguments: {},
      }),
    ).rejects.toMatchObject({
      data: { rejectionReason: 'BACKEND_UNROUTABLE' },
    });
  });

  it('lets audit middleware observe the rejection in-chain', async () => {
    const seen: string[] = [];
    const auditMW: ToolMiddleware = async (req, next) => {
      try {
        return await next(req);
      } catch (err) {
        seen.push(`${req.params.name}:${String((err as Error).message)}`);
        throw err;
      }
    };
    const server = createProxyServer(
      { crm: makeMeshBackend(['lookup']) },
      { toolMiddleware: [auditMW] },
    );

    await expect(
      invokeHandler(server, 'tools/call', { name: 'lookup', arguments: {} }),
    ).rejects.toBeDefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('lookup:');
  });

  it('emits rejected telemetry naming the namespaced tool', async () => {
    const events: TelemetryEvent[] = [];
    const server = createProxyServer(
      { crm: makeMeshBackend(['lookup']) },
      { onTelemetry: (e) => events.push(e) },
    );

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'billing__charge',
        arguments: {},
      }),
    ).rejects.toBeDefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_call',
      tool: 'billing__charge',
      outcome: 'rejected',
      rejectionReason: 'BACKEND_UNROUTABLE',
    });
  });
});

// ── Global config against namespaced names ─────────────────────────────────

describe('createProxyServer() — mesh configuration is global and namespaced', () => {
  it('hides one tool on one backend by its namespaced name', async () => {
    const server = createProxyServer(
      {
        crm: makeMeshBackend(['lookup', 'delete_account']),
        docs: makeMeshBackend(['delete_account']),
      },
      { hiddenTools: ['crm__delete_account'] },
    );

    expect(await listToolNames(server)).toEqual([
      'crm__lookup',
      'docs__delete_account',
    ]);
    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'crm__delete_account',
        arguments: {},
      }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'TOOL_HIDDEN' } });
  });

  it('gives a hidden-tool predicate the namespaced name, so a prefix hides a backend', async () => {
    const seen: string[] = [];
    const server = createProxyServer(
      { crm: makeMeshBackend(['lookup']), docs: makeMeshBackend(['search']) },
      {
        hiddenTools: (name) => {
          seen.push(name);
          return name.startsWith('crm__');
        },
      },
    );

    expect(await listToolNames(server)).toEqual(['docs__search']);
    expect(seen).toContain('crm__lookup');
  });

  it('matches passThroughTools against the namespaced name', async () => {
    const transform: ToolMiddleware = async (req, next) => {
      const result = await next(req);
      return { ...result, structuredContent: { transformed: true } };
    };
    const observed: string[] = [];
    const observer = markPassThroughObserver<
      Parameters<ToolMiddleware>[0],
      Awaited<ReturnType<ToolMiddleware>>
    >(async (req, next) => {
      observed.push(req.params.name);
      return next(req);
    });
    const server = createProxyServer(
      { crm: makeMeshBackend(['lookup']) },
      {
        toolMiddleware: [transform, observer],
        passThroughTools: ['crm__lookup'],
      },
    );

    const result = await invokeHandler(server, 'tools/call', {
      name: 'crm__lookup',
      arguments: {},
    });

    expect(result).not.toHaveProperty('structuredContent');
    expect(observed).toEqual(['crm__lookup']);
  });

  it('shows middleware the namespaced name and runs the pipeline once per call', async () => {
    const seen: string[] = [];
    const mw: ToolMiddleware = async (req, next) => {
      seen.push(req.params.name);
      return next(req);
    };
    const server = createProxyServer(
      { crm: makeMeshBackend(['lookup']), docs: makeMeshBackend(['search']) },
      { toolMiddleware: [mw] },
    );

    await invokeHandler(server, 'tools/call', {
      name: 'docs__search',
      arguments: {},
    });
    expect(seen).toEqual(['docs__search']);
  });
});

// ── Partial availability ───────────────────────────────────────────────────

describe('createProxyServer() — mesh degradation', () => {
  it('lists the live backends and reports the failed one', async () => {
    const crm = makeMeshBackend(['lookup']);
    const docs = makeMeshBackend(['search']);
    vi.mocked(docs.listTools).mockRejectedValue(new Error('upstream down'));
    const events: TelemetryEvent[] = [];
    const server = createProxyServer(
      { crm, docs },
      { onTelemetry: (e) => events.push(e) },
    );

    expect(await listToolNames(server)).toEqual(['crm__lookup']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'backend_degraded',
      backend: 'docs',
      method: 'tools/list',
    });
    expect((events[0] as { error: Error }).error.message).toBe('upstream down');
  });

  it('stamps the configured proxy identity onto a backend_degraded event', async () => {
    const crm = makeMeshBackend(['lookup']);
    const docs = makeMeshBackend(['search']);
    vi.mocked(docs.listTools).mockRejectedValue(new Error('upstream down'));
    const events: TelemetryEvent[] = [];
    const server = createProxyServer(
      { crm, docs },
      {
        onTelemetry: (e) => events.push(e),
        name: 'payments-proxy',
        version: '9.9.9',
      },
    );

    await listToolNames(server);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'backend_degraded',
      proxy: { name: 'payments-proxy', version: '9.9.9' },
    });
  });

  it('fails only the call routed to a down backend', async () => {
    const crm = makeMeshBackend(['lookup']);
    const docs = makeMeshBackend(['search']);
    vi.mocked(docs.callTool).mockRejectedValue(new Error('upstream down'));
    const server = createProxyServer({ crm, docs });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'docs__search',
        arguments: {},
      }),
    ).rejects.toThrow('upstream down');
    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'crm__lookup',
        arguments: {},
      }),
    ).resolves.toMatchObject({ content: [{ text: 'lookup' }] });
  });

  it('degrades silently but completely without an onTelemetry sink', async () => {
    const docs = makeMeshBackend(['search']);
    vi.mocked(docs.listTools).mockRejectedValue(new Error('upstream down'));
    const server = createProxyServer({
      crm: makeMeshBackend(['lookup']),
      docs,
    });

    expect(await listToolNames(server)).toEqual(['crm__lookup']);
  });

  it('never fails the list when the telemetry sink throws', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const docs = makeMeshBackend(['search']);
    vi.mocked(docs.listTools).mockRejectedValue(new Error('upstream down'));
    const server = createProxyServer(
      { crm: makeMeshBackend(['lookup']), docs },
      {
        onTelemetry: () => {
          throw new Error('sink down');
        },
      },
    );

    expect(await listToolNames(server)).toEqual(['crm__lookup']);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ── Pagination ──────────────────────────────────────────────────────────────

describe('createProxyServer() — mesh listing is unpaginated', () => {
  it('drains every backend page into one complete response', async () => {
    const crm = makeMeshBackend([]);
    vi.mocked(crm.listTools).mockImplementation((params) =>
      Promise.resolve(
        params?.cursor === undefined
          ? { tools: [tool('a')], nextCursor: 'p2' }
          : { tools: [tool('b')] },
      ),
    );
    const server = createProxyServer({ crm, docs: makeMeshBackend(['c']) });

    const result = (await invokeHandler(server, 'tools/list')) as {
      tools: { name: string }[];
      nextCursor?: string;
    };
    expect(result.tools.map((t) => t.name)).toEqual([
      'crm__a',
      'crm__b',
      'docs__c',
    ]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('drops and reports a backend that never finishes paginating', async () => {
    const crm = makeMeshBackend([]);
    vi.mocked(crm.listTools).mockResolvedValue({
      tools: [tool('a')],
      nextCursor: 'always-more',
    });
    const events: TelemetryEvent[] = [];
    const server = createProxyServer(
      { crm, docs: makeMeshBackend(['c']) },
      { onTelemetry: (e) => events.push(e) },
    );

    expect(await listToolNames(server)).toEqual(['docs__c']);
    expect(events[0]).toMatchObject({
      type: 'backend_degraded',
      backend: 'crm',
    });
  });

  it('keeps local tools on the response whatever cursor the client sent', async () => {
    const server = createProxyServer(
      { crm: makeMeshBackend(['lookup']) },
      {
        localTools: [
          {
            tool: tool('why_blocked'),
            handler: () => Promise.resolve({ content: [] }),
          },
        ],
      },
    );

    expect(await listToolNames(server, { cursor: 'stale' })).toEqual([
      'crm__lookup',
      'why_blocked',
    ]);
  });
});

// ── Capability union ────────────────────────────────────────────────────────

describe('createProxyServer() — mesh capability union', () => {
  it('advertises a capability when any backend has it', () => {
    const server = createProxyServer({
      crm: makeMeshBackend(['lookup'], { capabilities: { tools: {} } }),
      wiki: makeMeshBackend([], { capabilities: { prompts: {} } }),
    });

    expect(advertisedCapabilities(server)).toEqual({ tools: {}, prompts: {} });
  });

  it('advertises listChanged when any backend supports it', () => {
    const server = createProxyServer({
      crm: makeMeshBackend(['lookup'], { capabilities: { tools: {} } }),
      docs: makeMeshBackend(['search'], {
        capabilities: { tools: { listChanged: true } },
      }),
    });

    expect(advertisedCapabilities(server)).toEqual({
      tools: { listChanged: true },
    });
  });

  it('advertises tools for localTools alone even when no backend has any', async () => {
    const server = createProxyServer(
      { wiki: makeMeshBackend([], { capabilities: { prompts: {} } }) },
      {
        localTools: [
          {
            tool: tool('why_blocked'),
            handler: () => Promise.resolve({ content: [] }),
          },
        ],
      },
    );

    expect(advertisedCapabilities(server)).toMatchObject({ tools: {} });
    expect(await listToolNames(server)).toEqual(['why_blocked']);
  });

  it('never advertises resources in mesh mode', async () => {
    const server = createProxyServer({
      crm: makeMeshBackend(['lookup'], {
        capabilities: { tools: {}, resources: { listChanged: true } },
      }),
    });

    expect(advertisedCapabilities(server).resources).toBeUndefined();
    await expect(invokeHandler(server, 'resources/list')).rejects.toThrow(
      'No handler registered for method: resources/list',
    );
  });
});

// ── localTools composition ──────────────────────────────────────────────────

describe('createProxyServer() — mesh localTools composition', () => {
  it('exposes local tools un-namespaced alongside namespaced upstream tools', async () => {
    const server = createProxyServer(
      { crm: makeMeshBackend(['lookup']) },
      {
        localTools: [
          {
            tool: tool('why_blocked'),
            handler: () => Promise.resolve({ content: [] }),
          },
        ],
      },
    );

    expect(await listToolNames(server)).toEqual(['crm__lookup', 'why_blocked']);
  });

  it('shadows a namespaced upstream tool with a local tool of that name', async () => {
    const crm = makeMeshBackend(['lookup']);
    const server = createProxyServer(
      { crm },
      {
        localTools: [
          {
            tool: tool('crm__lookup'),
            handler: () =>
              Promise.resolve({ content: [{ type: 'text', text: 'local' }] }),
          },
        ],
      },
    );

    expect(await listToolNames(server)).toEqual(['crm__lookup']);
    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'crm__lookup',
        arguments: {},
      }),
    ).resolves.toMatchObject({ content: [{ text: 'local' }] });
    expect(crm.callTool).not.toHaveBeenCalled();
  });

  it('keeps hiddenTools ahead of a local tool in a mesh', async () => {
    const server = createProxyServer(
      { crm: makeMeshBackend(['lookup']) },
      {
        hiddenTools: ['why_blocked'],
        localTools: [
          {
            tool: tool('why_blocked'),
            handler: () => Promise.resolve({ content: [] }),
          },
        ],
      },
    );

    expect(await listToolNames(server)).toEqual(['crm__lookup']);
    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'why_blocked',
        arguments: {},
      }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'TOOL_HIDDEN' } });
  });
});

// ── list-changed fan-in ─────────────────────────────────────────────────────

describe('createProxyServer() — mesh list-changed fan-in', () => {
  it('forwards a notification from any backend, and unsubscribes from all on close', async () => {
    const crm = makeMeshBackend(['lookup'], {
      capabilities: { tools: { listChanged: true } },
    });
    const docs = makeMeshBackend(['search'], {
      capabilities: { tools: { listChanged: true } },
    });
    const server = createProxyServer({ crm, docs });
    const send = vi
      .spyOn(server, 'sendToolListChanged')
      .mockResolvedValue(undefined);

    await crm.__notificationHandlers.get(
      'notifications/tools/list_changed',
    )?.();
    await docs.__notificationHandlers.get(
      'notifications/tools/list_changed',
    )?.();
    expect(send).toHaveBeenCalledTimes(2);

    server.onclose?.();
    send.mockClear();
    await crm.__notificationHandlers.get(
      'notifications/tools/list_changed',
    )?.();
    await docs.__notificationHandlers.get(
      'notifications/tools/list_changed',
    )?.();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not forward a surface the mesh does not advertise', async () => {
    const crm = makeMeshBackend(['lookup'], {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
      },
    });
    const mesh = createProxyServer({ crm });
    const send = vi
      .spyOn(mesh, 'sendResourceListChanged')
      .mockResolvedValue(undefined);

    await crm.__notificationHandlers.get(
      'notifications/resources/list_changed',
    )?.();

    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a backend shared with a 1:1 proxy forwarding every surface', async () => {
    const shared = makeMeshBackend(['lookup'], {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
      },
    });
    // The mesh creates the bus first, and advertises no resources.
    const mesh = createProxyServer({ crm: shared });
    const direct = createProxyServer(shared);
    const meshSend = vi
      .spyOn(mesh, 'sendResourceListChanged')
      .mockResolvedValue(undefined);
    const directSend = vi
      .spyOn(direct, 'sendResourceListChanged')
      .mockResolvedValue(undefined);

    await shared.__notificationHandlers.get(
      'notifications/resources/list_changed',
    )?.();

    expect(directSend).toHaveBeenCalledOnce();
    expect(meshSend).not.toHaveBeenCalled();
  });
});

// ── Prompts ─────────────────────────────────────────────────────────────────

describe('createProxyServer() — mesh prompts', () => {
  it('namespaces prompt names and routes prompts/get by prefix', async () => {
    const wiki = makeMeshBackend([], {
      capabilities: { prompts: {} },
      prompts: ['brief'],
    });
    const server = createProxyServer({
      crm: makeMeshBackend(['lookup']),
      wiki,
    });

    const list = (await invokeHandler(server, 'prompts/list')) as {
      prompts: { name: string }[];
    };
    expect(list.prompts.map((p) => p.name)).toEqual(['wiki__brief']);

    await invokeHandler(server, 'prompts/get', { name: 'wiki__brief' });
    expect(wiki.getPrompt).toHaveBeenCalledWith({ name: 'brief' }, undefined);
  });

  it('rejects an unroutable prompt name', async () => {
    const server = createProxyServer({
      wiki: makeMeshBackend([], {
        capabilities: { prompts: {} },
        prompts: ['brief'],
      }),
    });

    await expect(
      invokeHandler(server, 'prompts/get', { name: 'brief' }),
    ).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
      data: { rejectionReason: 'BACKEND_UNROUTABLE' },
    });
  });

  it('runs promptMiddleware around a routed prompts/get', async () => {
    const wiki = makeMeshBackend([], {
      capabilities: { prompts: {} },
      prompts: ['brief'],
    });
    const seen: string[] = [];
    const mw: PromptMiddleware = async (req, next) => {
      seen.push(req.params.name);
      return next(req);
    };
    const server = createProxyServer({ wiki }, { promptMiddleware: [mw] });

    await invokeHandler(server, 'prompts/get', { name: 'wiki__brief' });

    // The middleware sees the namespaced name; routing happens inside the
    // innermost next, so the backend still receives the bare one.
    expect(seen).toEqual(['wiki__brief']);
    expect(wiki.getPrompt).toHaveBeenCalledWith({ name: 'brief' }, undefined);
  });

  it('forwards a middleware edit to params.arguments to the backend', async () => {
    const wiki = makeMeshBackend([], {
      capabilities: { prompts: {} },
      prompts: ['brief'],
    });
    const rewrite: PromptMiddleware = (req, next) =>
      next({ ...req, params: { ...req.params, arguments: { topic: 'q4' } } });
    const server = createProxyServer({ wiki }, { promptMiddleware: [rewrite] });

    await invokeHandler(server, 'prompts/get', {
      name: 'wiki__brief',
      arguments: { topic: 'q3' },
    });

    // Routing rebuilds params from the post-pipeline request, so the edit
    // survives the name rewrite instead of being clobbered by it.
    expect(wiki.getPrompt).toHaveBeenCalledWith(
      { name: 'brief', arguments: { topic: 'q4' } },
      undefined,
    );
  });

  it('throws BACKEND_UNROUTABLE inside the pipeline, so middleware observes it', async () => {
    const observed: unknown[] = [];
    const observer: PromptMiddleware = async (req, next) => {
      try {
        return await next(req);
      } catch (err) {
        observed.push(err);
        throw err;
      }
    };
    const server = createProxyServer(
      {
        wiki: makeMeshBackend([], {
          capabilities: { prompts: {} },
          prompts: ['brief'],
        }),
      },
      { promptMiddleware: [observer] },
    );

    await expect(
      invokeHandler(server, 'prompts/get', { name: 'brief' }),
    ).rejects.toMatchObject({
      data: { rejectionReason: 'BACKEND_UNROUTABLE' },
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      code: ErrorCode.MethodNotFound,
      data: { rejectionReason: 'BACKEND_UNROUTABLE' },
    });
  });

  it('degrades prompts/list when one backend fails', async () => {
    const wiki = makeMeshBackend([], {
      capabilities: { prompts: {} },
      prompts: ['brief'],
    });
    const kb = makeMeshBackend([], { capabilities: { prompts: {} } });
    vi.mocked(kb.listPrompts).mockRejectedValue(new Error('down'));
    const events: TelemetryEvent[] = [];
    const server = createProxyServer(
      { wiki, kb },
      { onTelemetry: (e) => events.push(e) },
    );

    const list = (await invokeHandler(server, 'prompts/list')) as {
      prompts: { name: string }[];
    };
    expect(list.prompts.map((p) => p.name)).toEqual(['wiki__brief']);
    expect(events[0]).toMatchObject({
      type: 'backend_degraded',
      backend: 'kb',
      method: 'prompts/list',
    });
  });
});

// ── Boundary behaviour carried into mesh mode ──────────────────────────────

describe('createProxyServer() — mesh boundary behaviour', () => {
  it('strips request _meta before forwarding and result _meta before returning', async () => {
    const crm = makeMeshBackend(['lookup']);
    vi.mocked(crm.callTool).mockResolvedValue({
      content: [],
      _meta: { upstream: 'trace' },
    });
    const server = createProxyServer({ crm });

    const result = await invokeHandler(server, 'tools/call', {
      name: 'crm__lookup',
      arguments: {},
      _meta: { progressToken: 1 },
    });

    expect(crm.callTool).toHaveBeenCalledWith(
      { name: 'lookup', arguments: {} },
      undefined,
      undefined,
    );
    expect(result).not.toHaveProperty('_meta');
  });
});
