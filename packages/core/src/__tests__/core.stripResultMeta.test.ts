import { describe, it, expect, vi } from 'vitest';
import { createProxyServer } from '../core.js';
import type { ToolMiddleware } from '../core.js';
import type { BackendClient } from '../backendClient.js';

// ── Test helpers ────────────────────────────────────────────────────────────

const UPSTREAM_META = {
  'io.modelcontextprotocol/related-task': { taskId: 'task-1' },
  'vendor/trace': 'abc123',
};

const TOOL_RESULT = {
  content: [{ type: 'text', text: 'ok', _meta: { block: 'level' } }],
  structuredContent: { answer: 42 },
  _meta: UPSTREAM_META,
};

function makeMockBackend(): BackendClient {
  return {
    getServerCapabilities: vi
      .fn()
      .mockReturnValue({ tools: {}, resources: {}, prompts: {} }),
    listTools: vi.fn().mockResolvedValue({
      tools: [{ name: 't', inputSchema: { type: 'object' }, _meta: { a: 1 } }],
      _meta: UPSTREAM_META,
    }),
    callTool: vi.fn().mockResolvedValue(TOOL_RESULT),
    listResources: vi
      .fn()
      .mockResolvedValue({ resources: [], _meta: UPSTREAM_META }),
    readResource: vi
      .fn()
      .mockResolvedValue({ contents: [], _meta: UPSTREAM_META }),
    listPrompts: vi
      .fn()
      .mockResolvedValue({ prompts: [], _meta: UPSTREAM_META }),
    getPrompt: vi
      .fn()
      .mockResolvedValue({ messages: [], _meta: UPSTREAM_META }),
    setNotificationHandler: vi.fn(),
    removeNotificationHandler: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BackendClient;
}

/** Invokes a registered handler directly via `_requestHandlers` — no transport needed. */
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

// ── The default ─────────────────────────────────────────────────────────────

describe('createProxyServer() — stripResultMeta defaults to on', () => {
  it('strips _meta from a tool call result before the client sees it', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {});

    const result = await invokeHandler(server, 'tools/call', {
      name: 'search_issues',
      arguments: {},
    });

    expect(result).not.toHaveProperty('_meta');
  });

  it.each([
    ['tools/list', {}],
    ['resources/list', {}],
    ['resources/read', { uri: 'res://a' }],
    ['prompts/list', {}],
    ['prompts/get', { name: 'p' }],
  ] as const)('strips result _meta from %s', async (method, params) => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {});

    const result = await invokeHandler(server, method, { ...params });
    expect(result).not.toHaveProperty('_meta');
  });

  it('applies to pass-through tools and resources too', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      passThroughTools: ['search_issues'],
      passThroughResources: ['res://a'],
    });

    const toolResult = await invokeHandler(server, 'tools/call', {
      name: 'search_issues',
      arguments: {},
    });
    expect(toolResult).not.toHaveProperty('_meta');

    const readResult = await invokeHandler(server, 'resources/read', {
      uri: 'res://a',
    });
    expect(readResult).not.toHaveProperty('_meta');
  });

  it('leaves block-level _meta, per-tool _meta, and structuredContent untouched', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {});

    const toolResult = (await invokeHandler(server, 'tools/call', {
      name: 'search_issues',
      arguments: {},
    })) as { content: unknown[]; structuredContent: unknown };
    expect(toolResult.content).toEqual([
      { type: 'text', text: 'ok', _meta: { block: 'level' } },
    ]);
    expect(toolResult.structuredContent).toEqual({ answer: 42 });

    const listResult = (await invokeHandler(server, 'tools/list')) as {
      tools: { _meta?: unknown }[];
    };
    expect(listResult.tools[0]?._meta).toEqual({ a: 1 });
  });

  it('does NOT strip a local tool result _meta', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      localTools: [
        {
          tool: { name: 'local_echo', inputSchema: { type: 'object' } },
          handler: async () => ({
            content: [{ type: 'text', text: 'local' }],
            _meta: { local: true },
          }),
        },
      ],
    });

    const result = await invokeHandler(server, 'tools/call', {
      name: 'local_echo',
      arguments: {},
    });
    expect(result).toHaveProperty('_meta', { local: true });
  });
});

// ── The boundary ────────────────────────────────────────────────────────────

describe('createProxyServer() — the strip happens inside the innermost next', () => {
  it('middleware sees the stripped result', async () => {
    const backend = makeMockBackend();
    let seenMeta: unknown = 'not-called';
    const observe: ToolMiddleware = async (req, next) => {
      const result = await next(req);
      seenMeta = result._meta;
      return result;
    };
    const server = createProxyServer(backend, { toolMiddleware: [observe] });

    await invokeHandler(server, 'tools/call', {
      name: 'search_issues',
      arguments: {},
    });
    expect(seenMeta).toBeUndefined();
  });

  it('middleware-added result _meta survives to the client', async () => {
    const backend = makeMockBackend();
    const addMeta: ToolMiddleware = async (req, next) => {
      const result = await next(req);
      return { ...result, _meta: { redactedBy: 'pii-mw' } };
    };
    const server = createProxyServer(backend, { toolMiddleware: [addMeta] });

    const result = await invokeHandler(server, 'tools/call', {
      name: 'search_issues',
      arguments: {},
    });
    expect(result).toHaveProperty('_meta', { redactedBy: 'pii-mw' });
  });
});

// ── The opt-out ─────────────────────────────────────────────────────────────

describe('createProxyServer() — stripResultMeta: false restores forwarding', () => {
  it('forwards result _meta verbatim when disabled', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { stripResultMeta: false });

    const result = await invokeHandler(server, 'tools/call', {
      name: 'search_issues',
      arguments: {},
    });
    expect(result).toHaveProperty('_meta', UPSTREAM_META);
  });
});
