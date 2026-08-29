import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createProxyServer,
  type ListToolsMiddleware,
  type PromptMiddleware,
  type ToolMiddleware,
} from '../core.js';
import type { BackendClient } from '../backendClient.js';
import { markPassThroughObserver } from '../middleware.js';
import type { ProxyContext } from '../proxyContext.js';
import type { ToolCallTelemetryEvent } from '../telemetry.js';
import {
  ErrorCode,
  PromptListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';

/** Independent copy of our own package version, read straight from disk. */
const pkgVersion = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../package.json', import.meta.url)),
      'utf8',
    ),
  ) as { version: string }
).version;

// ── Test helpers ────────────────────────────────────────────────────────────

function makeMockBackend(): BackendClient {
  const notificationHandlers = new Map<string, () => Promise<void>>();

  return {
    getServerCapabilities: vi.fn<() => ServerCapabilities>().mockReturnValue({
      tools: {},
      resources: {},
      prompts: {},
    }),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'normal_tool',
          description: 'Normal',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'sensitive_tool',
          description: 'Sensitive',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'pass_tool',
          description: 'Pass-through',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'raw upstream response' }],
    }),
    listResources: vi.fn().mockResolvedValue({
      resources: [
        {
          name: 'Normal Resource',
          uri: 'res://normal',
          mimeType: 'text/plain',
        },
        {
          name: 'Hidden Resource',
          uri: 'res://hidden',
          mimeType: 'text/plain',
        },
        { name: 'Pass Resource', uri: 'res://pass', mimeType: 'text/plain' },
      ],
    }),
    readResource: vi.fn().mockResolvedValue({
      contents: [
        { uri: 'res://normal', text: 'raw content', mimeType: 'text/plain' },
      ],
    }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createProxyServer() — hiddenTools', () => {
  it('filters hidden tools out of list_tools response', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      hiddenTools: ['sensitive_tool'],
      name: 'test-server',
    });

    const result = (await invokeHandler(server, 'tools/list')) as {
      tools: { name: string }[];
    };

    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain('sensitive_tool');
    expect(names).toContain('normal_tool');
    expect(names).toContain('pass_tool');
  });

  it('throws MethodNotFound when a hidden tool is called directly', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      hiddenTools: ['sensitive_tool'],
      name: 'test-server',
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'sensitive_tool',
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it('includes TOOL_HIDDEN rejection reason in error data', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      hiddenTools: ['sensitive_tool'],
      name: 'test-server',
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'sensitive_tool',
        arguments: {},
      }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'TOOL_HIDDEN' } });
  });

  it('returns full tool list when hiddenTools is empty', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      hiddenTools: [],
      name: 'test-server',
    });

    const result = (await invokeHandler(server, 'tools/list')) as {
      tools: { name: string }[];
    };
    expect(result.tools).toHaveLength(3);
  });

  it('still filters hidden tools after listToolsMiddleware mutates the response', async () => {
    const backend = makeMockBackend();
    const restoreHidden: ListToolsMiddleware = async (_req, next) => {
      const result = await next({ method: 'tools/list', params: {} });
      return {
        ...result,
        tools: [
          ...result.tools,
          {
            name: 'sensitive_tool',
            description: 'Reintroduced',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
    };
    const server = createProxyServer(backend, {
      hiddenTools: ['sensitive_tool'],
      listToolsMiddleware: [restoreHidden],
      name: 'test-server',
    });

    const result = (await invokeHandler(server, 'tools/list')) as {
      tools: { name: string }[];
    };

    expect(result.tools.map((tool) => tool.name)).not.toContain(
      'sensitive_tool',
    );
  });
});

describe('createProxyServer() — listToolsMiddleware', () => {
  it('runs in response-processing order like other ProxyOptions middleware arrays', async () => {
    const backend = makeMockBackend();
    const order: string[] = [];

    const descriptionMW: ListToolsMiddleware = async (req, next) => {
      order.push('description-enter');
      const result = await next(req);
      order.push('description-exit');
      return {
        ...result,
        tools: result.tools.map((tool) => ({
          ...tool,
          description: `${tool.description ?? ''} / described`,
        })),
      };
    };

    const suffixMW: ListToolsMiddleware = async (req, next) => {
      order.push('suffix-enter');
      const result = await next(req);
      order.push('suffix-exit');
      return {
        ...result,
        tools: result.tools.map((tool) => ({
          ...tool,
          description: `${tool.description ?? ''} / suffixed`,
        })),
      };
    };

    const server = createProxyServer(backend, {
      listToolsMiddleware: [descriptionMW, suffixMW],
      name: 'test-server',
    });

    const result = (await invokeHandler(server, 'tools/list')) as {
      tools: { description?: string }[];
    };

    expect(order).toEqual([
      'suffix-enter',
      'description-enter',
      'description-exit',
      'suffix-exit',
    ]);
    expect(result.tools[0]?.description).toBe('Normal / described / suffixed');
  });

  it('passes stdio ProxyContext to listToolsMiddleware by default', async () => {
    const backend = makeMockBackend();
    let seenContext: ProxyContext | undefined;

    const captureContext: ListToolsMiddleware = async (req, next, context) => {
      seenContext = context;
      return next(req);
    };

    const server = createProxyServer(backend, {
      listToolsMiddleware: [captureContext],
      name: 'test-server',
    });

    await invokeHandler(server, 'tools/list');

    expect(seenContext?.transport).toBe('stdio');
    expect(seenContext?.requestId).toEqual(expect.any(String));
    expect(seenContext?.sessionId).toBeUndefined();
    expect(seenContext?.headers).toBeUndefined();
  });
});

describe('createProxyServer() — passThroughTools', () => {
  it('bypasses middleware for pass-through tools (middleware spy not called)', async () => {
    const backend = makeMockBackend();
    const middlewareSpy = vi.fn<ToolMiddleware>((req, next) => next(req));
    const server = createProxyServer(backend, {
      passThroughTools: ['pass_tool'],
      toolMiddleware: [middlewareSpy],
      name: 'test-server',
    });

    await invokeHandler(server, 'tools/call', {
      name: 'pass_tool',
      arguments: {},
    });

    expect(middlewareSpy).not.toHaveBeenCalled();
  });

  it('returns the raw upstream response for pass-through tools', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      passThroughTools: ['pass_tool'],
      name: 'test-server',
    });

    const result = (await invokeHandler(server, 'tools/call', {
      name: 'pass_tool',
      arguments: {},
    })) as { content: { type: string; text: string }[] };

    expect(result.content[0]?.text).toBe('raw upstream response');
  });

  it('routes normal tools through the middleware pipeline', async () => {
    const backend = makeMockBackend();
    const middlewareSpy = vi.fn<ToolMiddleware>((req, next) => next(req));
    const server = createProxyServer(backend, {
      passThroughTools: ['pass_tool'],
      toolMiddleware: [middlewareSpy],
      name: 'test-server',
    });

    await invokeHandler(server, 'tools/call', {
      name: 'normal_tool',
      arguments: {},
    });

    expect(middlewareSpy).toHaveBeenCalledOnce();
  });

  it('passes stdio ProxyContext to tool middleware by default', async () => {
    const backend = makeMockBackend();
    let seenContext: ProxyContext | undefined;

    const captureContext: ToolMiddleware = async (req, next, context) => {
      seenContext = context;
      return next(req);
    };

    const server = createProxyServer(backend, {
      toolMiddleware: [captureContext],
      name: 'test-server',
    });

    await invokeHandler(server, 'tools/call', {
      name: 'normal_tool',
      arguments: {},
    });

    expect(seenContext?.transport).toBe('stdio');
    expect(seenContext?.requestId).toEqual(expect.any(String));
    expect(seenContext?.sessionId).toBeUndefined();
    expect(seenContext?.headers).toBeUndefined();
    expect(seenContext?.proxy).toEqual({
      name: 'test-server',
      version: pkgVersion,
    });
  });

  it('stamps a custom proxy identity onto the context', async () => {
    const backend = makeMockBackend();
    let seenContext: ProxyContext | undefined;

    const captureContext: ToolMiddleware = async (req, next, context) => {
      seenContext = context;
      return next(req);
    };

    const server = createProxyServer(backend, {
      toolMiddleware: [captureContext],
      name: 'payments-proxy',
      version: '9.9.9',
    });

    await invokeHandler(server, 'tools/call', {
      name: 'normal_tool',
      arguments: {},
    });

    expect(seenContext?.proxy).toEqual({
      name: 'payments-proxy',
      version: '9.9.9',
    });
  });
});

describe('createProxyServer() — hiddenResources', () => {
  it('filters hidden resources out of list_resources response', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      hiddenResources: ['res://hidden'],
      name: 'test-server',
    });

    const result = (await invokeHandler(server, 'resources/list')) as {
      resources: { uri: string }[];
    };

    const uris = result.resources.map((r) => r.uri);
    expect(uris).not.toContain('res://hidden');
    expect(uris).toContain('res://normal');
    expect(uris).toContain('res://pass');
  });

  it('throws InvalidRequest when a hidden resource is read directly', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      hiddenResources: ['res://hidden'],
      name: 'test-server',
    });

    await expect(
      invokeHandler(server, 'resources/read', { uri: 'res://hidden' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  it('includes RESOURCE_HIDDEN rejection reason in error data', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      hiddenResources: ['res://hidden'],
      name: 'test-server',
    });

    await expect(
      invokeHandler(server, 'resources/read', { uri: 'res://hidden' }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'RESOURCE_HIDDEN' } });
  });

  it('returns full resource list when hiddenResources is empty', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      hiddenResources: [],
      name: 'test-server',
    });

    const result = (await invokeHandler(server, 'resources/list')) as {
      resources: { uri: string }[];
    };
    expect(result.resources).toHaveLength(3);
  });
});

describe('createProxyServer() — passThroughResources', () => {
  it('bypasses middleware for pass-through resources', async () => {
    const backend = makeMockBackend();
    const middlewareSpy = vi.fn(
      (req: unknown, next: (r: unknown) => Promise<unknown>) => next(req),
    );
    const server = createProxyServer(backend, {
      passThroughResources: ['res://pass'],
      resourceMiddleware: [middlewareSpy as never],
      name: 'test-server',
    });

    await invokeHandler(server, 'resources/read', { uri: 'res://pass' });

    expect(middlewareSpy).not.toHaveBeenCalled();
  });

  it('returns the raw upstream response for pass-through resources', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      passThroughResources: ['res://pass'],
      name: 'test-server',
    });

    const result = (await invokeHandler(server, 'resources/read', {
      uri: 'res://pass',
    })) as { contents: { text: string }[] };

    expect(result.contents[0]?.text).toBe('raw content');
  });
});

describe('createProxyServer() — capability mirroring', () => {
  it('advertises only upstream capabilities', async () => {
    const backend = makeMockBackend();
    vi.mocked(backend.getServerCapabilities).mockReturnValue({ tools: {} });
    const server = createProxyServer(backend, { name: 'test-server' });

    const result = (await invokeHandler(server, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    })) as { capabilities: ServerCapabilities };

    expect(result.capabilities).toEqual({ tools: {} });
    await expect(invokeHandler(server, 'prompts/list')).rejects.toThrow(
      'No handler registered for method: prompts/list',
    );
    // No prompts capability means no prompts/get handler either: the SDK
    // refuses to register one, so there is no pipeline to reject inside
    // and nothing for audit to record (ADR-0014).
    await expect(invokeHandler(server, 'prompts/get')).rejects.toThrow(
      'No handler registered for method: prompts/get',
    );
    await expect(invokeHandler(server, 'resources/list')).rejects.toThrow(
      'No handler registered for method: resources/list',
    );
  });
});

describe('createProxyServer() — notification fanout', () => {
  it('fans list-changed notifications to active proxy servers only', async () => {
    const backend = makeMockBackend() as BackendClient & {
      __notificationHandlers: Map<string, () => Promise<void>>;
    };

    vi.mocked(backend.getServerCapabilities).mockReturnValue({
      tools: { listChanged: true },
    });

    const serverA = createProxyServer(backend, { name: 'test-server' });
    const serverB = createProxyServer(backend, { name: 'test-server' });

    const sendA = vi
      .spyOn(serverA, 'sendToolListChanged')
      .mockResolvedValue(undefined);
    const sendB = vi
      .spyOn(serverB, 'sendToolListChanged')
      .mockResolvedValue(undefined);

    await backend.__notificationHandlers.get(
      'notifications/tools/list_changed',
    )?.();

    expect(sendA).toHaveBeenCalledOnce();
    expect(sendB).toHaveBeenCalledOnce();

    serverA.onclose?.();
    sendA.mockClear();
    sendB.mockClear();

    await backend.__notificationHandlers.get(
      'notifications/tools/list_changed',
    )?.();

    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).toHaveBeenCalledOnce();
  });
});

describe('createProxyServer() — request options', () => {
  it('forwards signal and progress for tool calls', async () => {
    const backend = makeMockBackend();
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();

    vi.mocked(backend.callTool).mockImplementation(
      async (_params, _schema, options) => {
        options?.onprogress?.({ progress: 2, total: 5, message: 'working' });
        expect(options?.signal).toBe(controller.signal);
        return { content: [{ type: 'text', text: 'raw upstream response' }] };
      },
    );

    const server = createProxyServer(backend, { name: 'test-server' });

    await invokeHandler(
      server,
      'tools/call',
      { name: 'normal_tool', arguments: {} },
      {
        signal: controller.signal,
        requestId: 1,
        sendNotification,
        _meta: { progressToken: 'progress-1' },
      },
    );

    expect(sendNotification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: {
        progressToken: 'progress-1',
        progress: 2,
        total: 5,
        message: 'working',
      },
    });
  });

  it('forwards signal for resource reads', async () => {
    const backend = makeMockBackend();
    const controller = new AbortController();

    vi.mocked(backend.readResource).mockImplementation(
      async (_params, options) => {
        expect(options?.signal).toBe(controller.signal);
        return {
          contents: [
            {
              uri: 'res://normal',
              text: 'raw content',
              mimeType: 'text/plain',
            },
          ],
        };
      },
    );

    const server = createProxyServer(backend, { name: 'test-server' });

    await invokeHandler(
      server,
      'resources/read',
      { uri: 'res://normal' },
      {
        signal: controller.signal,
        requestId: 1,
        sendNotification: vi.fn().mockResolvedValue(undefined),
      },
    );
  });
});

describe('createProxyServer() — onTelemetry', () => {
  it('emits a success event after a successful tool call', async () => {
    const backend = makeMockBackend();
    const events: ToolCallTelemetryEvent[] = [];
    const server = createProxyServer(backend, {
      onTelemetry: (e) => {
        if (e.type === 'tool_call') events.push(e);
      },
      name: 'test-server',
    });

    await invokeHandler(server, 'tools/call', {
      name: 'echo',
      arguments: { msg: 'hi' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_call',
      tool: 'echo',
      outcome: 'success',
    });
    expect(typeof events[0]!.duration_ms).toBe('number');
  });

  it('stamps the configured proxy identity onto every tool_call event', async () => {
    const backend = makeMockBackend();
    const events: ToolCallTelemetryEvent[] = [];
    const server = createProxyServer(backend, {
      onTelemetry: (e) => {
        if (e.type === 'tool_call') events.push(e);
      },
      name: 'payments-proxy',
      version: '9.9.9',
    });

    await invokeHandler(server, 'tools/call', {
      name: 'echo',
      arguments: { msg: 'hi' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.proxy).toEqual({
      name: 'payments-proxy',
      version: '9.9.9',
    });
  });

  it('emits a rejected event with TOOL_HIDDEN when a hidden tool is called', async () => {
    const backend = makeMockBackend();
    const events: ToolCallTelemetryEvent[] = [];
    const server = createProxyServer(backend, {
      hiddenTools: ['sensitive_tool'],
      onTelemetry: (e) => {
        if (e.type === 'tool_call') events.push(e);
      },
      name: 'test-server',
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'sensitive_tool',
        arguments: {},
      }),
    ).rejects.toBeDefined();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_call',
      tool: 'sensitive_tool',
      outcome: 'rejected',
      rejectionReason: 'TOOL_HIDDEN',
    });
  });

  it('emits an error event when the upstream throws', async () => {
    const backend = makeMockBackend();
    vi.mocked(backend.callTool).mockRejectedValueOnce(
      new Error('upstream failure'),
    );
    const events: ToolCallTelemetryEvent[] = [];
    const server = createProxyServer(backend, {
      onTelemetry: (e) => {
        if (e.type === 'tool_call') events.push(e);
      },
      name: 'test-server',
    });

    await expect(
      invokeHandler(server, 'tools/call', { name: 'echo', arguments: {} }),
    ).rejects.toBeDefined();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_call',
      tool: 'echo',
      outcome: 'error',
    });
  });
});

describe('createProxyServer() — server identity', () => {
  // The MCP SDK stores the advertised server info on a protected `_serverInfo`.
  const serverInfo = (server: ReturnType<typeof createProxyServer>) => {
    return (
      server as unknown as { _serverInfo: { name: string; version: string } }
    )._serverInfo;
  };

  it('honors an explicit name when provided', () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { name: 'my-proxy' });

    expect(serverInfo(server).name).toBe('my-proxy');
  });

  it('defaults version to the mcpose library version when omitted', () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { name: 'test-server' });

    expect(serverInfo(server).version).toBe(pkgVersion);
    // Regression guard against the stale hardcoded '1.1.1'.
    expect(serverInfo(server).version).not.toBe('1.1.1');
  });

  it('honors an explicit version, independent of the library version', () => {
    const backend = makeMockBackend();
    // A developer ships their own proxy version on top of a pinned library.
    const server = createProxyServer(backend, {
      name: 'test-server',
      version: '9.9.9',
    });

    expect(serverInfo(server).version).toBe('9.9.9');
  });
});

// ── rejection + pass-through observation ────────────────────────────────────

describe('createProxyServer() — rejection and pass-through observation', () => {
  it('lets tool middleware observe a TOOL_HIDDEN rejection in-chain', async () => {
    const backend = makeMockBackend();
    let observed: unknown;
    const mw: ToolMiddleware = async (req, next) => {
      try {
        return await next(req);
      } catch (err) {
        observed = err;
        throw err;
      }
    };
    const server = createProxyServer(backend, {
      hiddenTools: ['sensitive_tool'],
      toolMiddleware: [mw],
      name: 'test-server',
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'sensitive_tool',
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });

    expect(observed).toMatchObject({
      data: { rejectionReason: 'TOOL_HIDDEN' },
    });
    // The backend must never be called for a hidden tool.
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('runs marked observer middleware for pass-through tools, skips unmarked', async () => {
    const backend = makeMockBackend();
    const calls: string[] = [];
    const observer: ToolMiddleware = markPassThroughObserver(
      async (req, next) => {
        calls.push('observer');
        return next(req);
      },
    );
    const transformer: ToolMiddleware = async (req, next) => {
      calls.push('transformer');
      return next(req);
    };
    const server = createProxyServer(backend, {
      passThroughTools: ['pass_tool'],
      toolMiddleware: [transformer, observer],
      name: 'test-server',
    });

    await invokeHandler(server, 'tools/call', {
      name: 'pass_tool',
      arguments: {},
    });
    expect(calls).toEqual(['observer']);
    expect(backend.callTool).toHaveBeenCalledTimes(1);

    // A non-pass-through tool runs both.
    calls.length = 0;
    await invokeHandler(server, 'tools/call', {
      name: 'normal_tool',
      arguments: {},
    });
    expect(calls).toEqual(['observer', 'transformer']);
  });

  it('keeps hidden precedence over passThrough, observed by marked middleware', async () => {
    const backend = makeMockBackend();
    let observed: unknown;
    const observer: ToolMiddleware = markPassThroughObserver(
      async (req, next) => {
        try {
          return await next(req);
        } catch (err) {
          observed = err;
          throw err;
        }
      },
    );
    const server = createProxyServer(backend, {
      hiddenTools: ['pass_tool'],
      passThroughTools: ['pass_tool'],
      toolMiddleware: [observer],
      name: 'test-server',
    });

    await expect(
      invokeHandler(server, 'tools/call', { name: 'pass_tool', arguments: {} }),
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    expect(observed).toMatchObject({
      data: { rejectionReason: 'TOOL_HIDDEN' },
    });
    expect(backend.callTool).not.toHaveBeenCalled();
  });
});

// ── telemetry outcomes ──────────────────────────────────────────────────────

describe('createProxyServer() — telemetry outcomes', () => {
  it('reports isError tool results as outcome error', async () => {
    const backend = makeMockBackend();
    (backend.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: 'text', text: 'tool-level failure' }],
      isError: true,
    });
    const events: ToolCallTelemetryEvent[] = [];
    const server = createProxyServer(backend, {
      onTelemetry: (e) => {
        if (e.type === 'tool_call') events.push(e);
      },
      name: 'test-server',
    });

    await invokeHandler(server, 'tools/call', {
      name: 'normal_tool',
      arguments: {},
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('error');
  });

  it('emits rejected telemetry with TOOL_HIDDEN for hidden tools', async () => {
    const backend = makeMockBackend();
    const events: ToolCallTelemetryEvent[] = [];
    const server = createProxyServer(backend, {
      hiddenTools: ['sensitive_tool'],
      onTelemetry: (e) => {
        if (e.type === 'tool_call') events.push(e);
      },
      name: 'test-server',
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'sensitive_tool',
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'rejected',
      rejectionReason: 'TOOL_HIDDEN',
    });
  });

  it('does not fail the call when onTelemetry throws', async () => {
    const backend = makeMockBackend();
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const server = createProxyServer(backend, {
      onTelemetry: () => {
        throw new Error('sink down');
      },
      name: 'test-server',
    });

    const result = await invokeHandler(server, 'tools/call', {
      name: 'normal_tool',
      arguments: {},
    });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'raw upstream response' }],
    });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('createProxyServer() — promptMiddleware', () => {
  it('runs around prompts/get in 1:1 mode', async () => {
    const backend = makeMockBackend();
    const seen: string[] = [];
    const mw: PromptMiddleware = async (req, next) => {
      seen.push(req.params.name);
      const result = await next(req);
      return { ...result, description: 'wrapped' };
    };
    const server = createProxyServer(backend, {
      promptMiddleware: [mw],
      name: 'test-server',
    });

    const result = (await invokeHandler(server, 'prompts/get', {
      name: 'brief',
    })) as { description?: string };

    expect(seen).toEqual(['brief']);
    expect(result.description).toBe('wrapped');
    expect(backend.getPrompt).toHaveBeenCalledWith(
      { name: 'brief' },
      undefined,
    );
  });

  it('runs in response-processing order (first = innermost), per ADR-0002', async () => {
    const backend = makeMockBackend();
    const order: string[] = [];

    const innerMW: PromptMiddleware = async (req, next) => {
      order.push('inner-enter');
      const result = await next(req);
      order.push('inner-exit');
      return result;
    };
    const outerMW: PromptMiddleware = async (req, next) => {
      order.push('outer-enter');
      const result = await next(req);
      order.push('outer-exit');
      return result;
    };

    const server = createProxyServer(backend, {
      promptMiddleware: [innerMW, outerMW],
      name: 'test-server',
    });

    await invokeHandler(server, 'prompts/get', { name: 'brief' });

    expect(order).toEqual([
      'outer-enter',
      'inner-enter',
      'inner-exit',
      'outer-exit',
    ]);
  });

  it('sees the stripped request and the stripped upstream result', async () => {
    const backend = makeMockBackend();
    vi.mocked(backend.getPrompt).mockResolvedValue({
      messages: [],
      _meta: { 'vendor/trace': 'abc' },
    });
    let observedReq: unknown;
    let observedResult: unknown;
    const mw: PromptMiddleware = async (req, next) => {
      observedReq = req.params;
      const result = await next(req);
      observedResult = result;
      return result;
    };
    const server = createProxyServer(backend, {
      promptMiddleware: [mw],
      name: 'test-server',
    });

    await invokeHandler(server, 'prompts/get', {
      name: 'brief',
      _meta: { 'vscode/conversationId': 'c1' },
    });

    expect(observedReq).not.toHaveProperty('_meta');
    expect(observedResult).not.toHaveProperty('_meta');
  });
});
