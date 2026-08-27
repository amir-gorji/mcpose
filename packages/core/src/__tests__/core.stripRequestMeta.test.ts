import { describe, it, expect, vi } from 'vitest';
import { createProxyServer } from '../core.js';
import type { ToolMiddleware } from '../core.js';
import type { BackendClient } from '../backendClient.js';

// ── Test helpers ────────────────────────────────────────────────────────────

const CLIENT_META = {
  progressToken: 3,
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  'vscode/conversationId': 'a-uuid',
};

function makeMockBackend(): BackendClient {
  return {
    getServerCapabilities: vi
      .fn()
      .mockReturnValue({ tools: {}, resources: {}, prompts: {} }),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    }),
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
    readResource: vi.fn().mockResolvedValue({ contents: [] }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
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

function upstreamParams(mock: unknown): Record<string, unknown> {
  return (mock as { mock: { calls: [Record<string, unknown>][] } }).mock
    .calls[0]![0];
}

// ── The default ─────────────────────────────────────────────────────────────

describe('createProxyServer() — stripRequestMeta defaults to on', () => {
  it('strips _meta from a tool call before the upstream sees it', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {});

    await invokeHandler(server, 'tools/call', {
      name: 'search_issues',
      arguments: { q: 'x' },
      _meta: CLIENT_META,
    });

    const params = upstreamParams(backend.callTool);
    expect(params).not.toHaveProperty('_meta');
    expect(params).toMatchObject({
      name: 'search_issues',
      arguments: { q: 'x' },
    });
  });

  it.each([
    ['tools/list', 'listTools'],
    ['resources/list', 'listResources'],
    ['prompts/list', 'listPrompts'],
  ] as const)('strips _meta from %s', async (method, backendMethod) => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {});

    await invokeHandler(server, method, { _meta: CLIENT_META });
    expect(
      upstreamParams(backend[backendMethod as keyof BackendClient]),
    ).not.toHaveProperty('_meta');
  });

  it('strips _meta from a resource read and a prompt get', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {});

    await invokeHandler(server, 'resources/read', {
      uri: 'res://a',
      _meta: CLIENT_META,
    });
    expect(upstreamParams(backend.readResource)).not.toHaveProperty('_meta');

    await invokeHandler(server, 'prompts/get', {
      name: 'p',
      _meta: CLIENT_META,
    });
    expect(upstreamParams(backend.getPrompt)).not.toHaveProperty('_meta');
  });

  it('applies to pass-through tools too', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      passThroughTools: ['search_issues'],
    });

    await invokeHandler(server, 'tools/call', {
      name: 'search_issues',
      arguments: {},
      _meta: CLIENT_META,
    });
    expect(upstreamParams(backend.callTool)).not.toHaveProperty('_meta');
  });
});

// ── The boundary ────────────────────────────────────────────────────────────

describe('createProxyServer() — the strip happens before the pipeline', () => {
  it('middleware sees the stripped request', async () => {
    const backend = makeMockBackend();
    let seenMeta: unknown = 'not-called';
    const observe: ToolMiddleware = async (req, next) => {
      seenMeta = req.params._meta;
      return next(req);
    };
    const server = createProxyServer(backend, { toolMiddleware: [observe] });

    await invokeHandler(server, 'tools/call', {
      name: 'search_issues',
      arguments: {},
      _meta: CLIENT_META,
    });
    expect(seenMeta).toBeUndefined();
  });

  it('middleware can still add its own _meta deliberately, and it reaches the upstream', async () => {
    const backend = makeMockBackend();
    const addMeta: ToolMiddleware = async (req, next) =>
      next({
        ...req,
        params: { ...req.params, _meta: { tenant: 'bank-pilot' } },
      });
    const server = createProxyServer(backend, { toolMiddleware: [addMeta] });

    await invokeHandler(server, 'tools/call', {
      name: 'search_issues',
      arguments: {},
      _meta: CLIENT_META,
    });
    expect(upstreamParams(backend.callTool)._meta).toEqual({
      tenant: 'bank-pilot',
    });
  });

  it('progress relay is unaffected: the token is read from the request extra, not params._meta', async () => {
    const backend = makeMockBackend();
    const callToolWithProgress = vi.fn(
      async (
        _params: unknown,
        _schema: unknown,
        options?: { onprogress?: (p: { progress: number }) => void },
      ) => {
        options?.onprogress?.({ progress: 1 });
        return { content: [] };
      },
    );
    (backend as unknown as { callTool: unknown }).callTool =
      callToolWithProgress;
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const server = createProxyServer(backend, {});

    await invokeHandler(
      server,
      'tools/call',
      { name: 'search_issues', arguments: {}, _meta: CLIENT_META },
      { _meta: { progressToken: 3 }, sendNotification },
    );

    expect(upstreamParams(callToolWithProgress)).not.toHaveProperty('_meta');
    const notification = sendNotification.mock.calls[0]?.[0] as {
      method: string;
      params: { progressToken: number; progress: number };
    };
    expect(notification.method).toBe('notifications/progress');
    expect(notification.params).toMatchObject({
      progressToken: 3,
      progress: 1,
    });
  });
});

// ── The opt-out ─────────────────────────────────────────────────────────────

describe('createProxyServer() — stripRequestMeta: false restores forwarding', () => {
  it('forwards _meta verbatim when disabled', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { stripRequestMeta: false });

    await invokeHandler(server, 'tools/call', {
      name: 'search_issues',
      arguments: {},
      _meta: CLIENT_META,
    });
    expect(upstreamParams(backend.callTool)._meta).toEqual(CLIENT_META);
  });
});
