import { describe, it, expect, vi } from 'vitest';
import { createProxyServer, startHttpProxy, type LocalTool } from '../core.js';
import type { ToolMiddleware, ListToolsMiddleware } from '../core.js';
import type { BackendClient } from '../backendClient.js';
import type { ProxyContext } from '../proxyContext.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeMockBackend(capabilities: object = { tools: {} }): BackendClient {
  return {
    getServerCapabilities: vi.fn().mockReturnValue(capabilities),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'upstream_tool',
          description: 'Upstream',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'shadowed_tool',
          description: 'Upstream version',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'upstream response' }],
    }),
    setNotificationHandler: vi.fn(),
    removeNotificationHandler: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BackendClient;
}

function makeLocalTool(
  name: string,
  handler?: LocalTool['handler'],
): LocalTool {
  return {
    tool: {
      name,
      description: `Local ${name}`,
      inputSchema: { type: 'object', properties: {} },
    },
    handler:
      handler ??
      (async () => ({ content: [{ type: 'text', text: `local ${name}` }] })),
  };
}

/** Invokes a registered handler directly via `_requestHandlers` — no transport needed. */
async function invokeHandler(
  server: ReturnType<typeof createProxyServer>,
  method: string,
  params: Record<string, unknown> = {},
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
  return handler({ method, params }, {});
}

type ListResult = { tools: { name: string; description?: string }[] };

// ── Listing ─────────────────────────────────────────────────────────────────

describe('createProxyServer() — localTools appear in tools/list', () => {
  it('lists local tools alongside upstream tools', async () => {
    const server = createProxyServer(makeMockBackend(), {
      name: 'test-server',
      localTools: [makeLocalTool('local_tool')],
    });

    const result = (await invokeHandler(server, 'tools/list')) as ListResult;
    expect(result.tools.map((t) => t.name)).toEqual([
      'upstream_tool',
      'shadowed_tool',
      'local_tool',
    ]);
  });

  it('adds local tools inside the innermost next, so listToolsMiddleware sees them', async () => {
    let seenByMiddleware: string[] = [];
    const observe: ListToolsMiddleware = async (req, next) => {
      const result = await next(req);
      seenByMiddleware = result.tools.map((t) => t.name);
      return result;
    };
    const server = createProxyServer(makeMockBackend(), {
      name: 'test-server',
      localTools: [makeLocalTool('local_tool')],
      listToolsMiddleware: [observe],
    });

    await invokeHandler(server, 'tools/list');
    expect(seenByMiddleware).toContain('local_tool');
  });

  it('adds local tools to the first page only, so pagination does not duplicate them', async () => {
    const server = createProxyServer(makeMockBackend(), {
      name: 'test-server',
      localTools: [makeLocalTool('local_tool')],
    });

    const page2 = (await invokeHandler(server, 'tools/list', {
      cursor: 'page-2',
    })) as ListResult;
    expect(page2.tools.map((t) => t.name)).not.toContain('local_tool');
  });

  it('filters a shadowed upstream duplicate on later pages too, so the client sees one entry per name', async () => {
    const server = createProxyServer(makeMockBackend(), {
      name: 'test-server',
      localTools: [makeLocalTool('shadowed_tool')],
    });

    const page2 = (await invokeHandler(server, 'tools/list', {
      cursor: 'page-2',
    })) as ListResult;
    expect(page2.tools.map((t) => t.name)).toEqual(['upstream_tool']);
  });

  it('a local tool shadows an upstream tool of the same name — one entry, the local one', async () => {
    const server = createProxyServer(makeMockBackend(), {
      name: 'test-server',
      localTools: [makeLocalTool('shadowed_tool')],
    });

    const result = (await invokeHandler(server, 'tools/list')) as ListResult;
    const entries = result.tools.filter((t) => t.name === 'shadowed_tool');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.description).toBe('Local shadowed_tool');
  });
});

// ── Calling ─────────────────────────────────────────────────────────────────

describe('createProxyServer() — a local tool call routes to its handler', () => {
  it('runs the handler with params and context; the upstream is never consulted', async () => {
    const backend = makeMockBackend();
    let seenContext: ProxyContext | undefined;
    const handler = vi.fn(
      async (params: Record<string, unknown>, context: ProxyContext) => {
        seenContext = context;
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(params.arguments) },
          ],
        };
      },
    );
    const server = createProxyServer(backend, {
      name: 'test-server',
      localTools: [makeLocalTool('local_tool', handler)],
    });

    const result = await invokeHandler(server, 'tools/call', {
      name: 'local_tool',
      arguments: { a: 1 },
    });

    expect(result).toMatchObject({ content: [{ text: '{"a":1}' }] });
    expect(handler).toHaveBeenCalledOnce();
    expect(seenContext?.requestId).toBeTruthy();
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('runs the full toolMiddleware pipeline around the handler', async () => {
    const redact: ToolMiddleware = async (req, next) => {
      const result = await next(req);
      return { ...result, content: [{ type: 'text', text: 'redacted' }] };
    };
    const server = createProxyServer(makeMockBackend(), {
      name: 'test-server',
      localTools: [makeLocalTool('local_tool')],
      toolMiddleware: [redact],
    });

    const result = await invokeHandler(server, 'tools/call', {
      name: 'local_tool',
      arguments: {},
    });
    expect(result).toMatchObject({ content: [{ text: 'redacted' }] });
  });

  it('a shadowed name routes to the local handler, not the upstream', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      name: 'test-server',
      localTools: [makeLocalTool('shadowed_tool')],
    });

    const result = await invokeHandler(server, 'tools/call', {
      name: 'shadowed_tool',
      arguments: {},
    });
    expect(result).toMatchObject({
      content: [{ text: 'local shadowed_tool' }],
    });
    expect(backend.callTool).not.toHaveBeenCalled();
  });
});

// ── Precedence ──────────────────────────────────────────────────────────────

describe('createProxyServer() — localTools precedence', () => {
  it('hiddenTools beats a local tool: filtered from the list, rejected with TOOL_HIDDEN', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const server = createProxyServer(makeMockBackend(), {
      name: 'test-server',
      localTools: [makeLocalTool('local_tool', handler)],
      hiddenTools: ['local_tool'],
    });

    const listed = (await invokeHandler(server, 'tools/list')) as ListResult;
    expect(listed.tools.map((t) => t.name)).not.toContain('local_tool');

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'local_tool',
        arguments: {},
      }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'TOOL_HIDDEN' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('passThroughTools has no effect on a local tool: transforming middleware still runs', async () => {
    const transform: ToolMiddleware = async (req, next) => {
      const result = await next(req);
      return { ...result, content: [{ type: 'text', text: 'transformed' }] };
    };
    const server = createProxyServer(makeMockBackend(), {
      name: 'test-server',
      localTools: [makeLocalTool('local_tool')],
      passThroughTools: ['local_tool'],
      toolMiddleware: [transform],
    });

    const result = await invokeHandler(server, 'tools/call', {
      name: 'local_tool',
      arguments: {},
    });
    expect(result).toMatchObject({ content: [{ text: 'transformed' }] });
  });

  it('throws at createProxyServer on a duplicate local tool name', () => {
    expect(() =>
      createProxyServer(makeMockBackend(), {
        name: 'test-server',
        localTools: [makeLocalTool('dup'), makeLocalTool('dup')],
      }),
    ).toThrow(/duplicate local tool name "dup"/);
  });

  it('throws at startHttpProxy startup on a duplicate local tool name, not on first initialize', () => {
    expect(() =>
      startHttpProxy(
        makeMockBackend(),
        {
          name: 'test-server',
          localTools: [makeLocalTool('dup'), makeLocalTool('dup')],
        },
        { port: 0 },
      ),
    ).toThrow(/duplicate local tool name "dup"/);
  });
});

// ── Tools-less upstream ─────────────────────────────────────────────────────

describe('createProxyServer() — localTools against an upstream without tools', () => {
  it('advertises the tools capability and serves the local tool', async () => {
    const backend = makeMockBackend({ resources: {} });
    const server = createProxyServer(backend, {
      name: 'test-server',
      localTools: [makeLocalTool('local_tool')],
    });

    const listed = (await invokeHandler(server, 'tools/list')) as ListResult;
    expect(listed.tools.map((t) => t.name)).toEqual(['local_tool']);
    expect(backend.listTools).not.toHaveBeenCalled();

    const result = await invokeHandler(server, 'tools/call', {
      name: 'local_tool',
      arguments: {},
    });
    expect(result).toMatchObject({ content: [{ text: 'local local_tool' }] });
  });

  it('rejects an unknown tool with MethodNotFound instead of forwarding upstream', async () => {
    const backend = makeMockBackend({ resources: {} });
    const server = createProxyServer(backend, {
      name: 'test-server',
      localTools: [makeLocalTool('local_tool')],
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'no_such_tool',
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    expect(backend.callTool).not.toHaveBeenCalled();
  });
});
