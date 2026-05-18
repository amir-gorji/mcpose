import { describe, it, expect, vi } from 'vitest';
import {
  createProxyServer,
  type ToolMiddleware,
} from '../core.js';
import type { BackendClient } from '../backendClient.js';
import {
  ErrorCode,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeRichBackend(capabilities: ServerCapabilities | undefined): BackendClient & {
  __notificationHandlers: Map<string, () => Promise<void>>;
} {
  const notificationHandlers = new Map<string, () => Promise<void>>();
  return {
    getServerCapabilities: vi.fn().mockReturnValue(capabilities),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        { name: 'normal_tool', description: 'n', inputSchema: { type: 'object', properties: {} } },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    listResources: vi.fn().mockResolvedValue({
      resources: [
        { name: 'a', uri: 'res://a', mimeType: 'text/plain' },
        { name: 'b', uri: 'res://b', mimeType: 'text/plain' },
      ],
    }),
    readResource: vi.fn().mockResolvedValue({ contents: [] }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
    setNotificationHandler: vi.fn((schema, handler) => {
      const method =
        schema === ToolListChangedNotificationSchema
          ? 'notifications/tools/list_changed'
          : schema === PromptListChangedNotificationSchema
            ? 'notifications/prompts/list_changed'
            : schema === ResourceListChangedNotificationSchema
              ? 'notifications/resources/list_changed'
              : 'unknown';
      notificationHandlers.set(method, handler as () => Promise<void>);
    }),
    removeNotificationHandler: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    __notificationHandlers: notificationHandlers,
  } as unknown as BackendClient & {
    __notificationHandlers: Map<string, () => Promise<void>>;
  };
}

async function invoke(
  server: ReturnType<typeof createProxyServer>,
  method: string,
  params: Record<string, unknown> = {},
  extra: object = {},
): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = (server as any)._requestHandlers as Map<
    string,
    (req: { method: string; params: Record<string, unknown> }, extra: object) => Promise<unknown>
  >;
  const handler = handlers.get(method);
  if (!handler) throw new Error(`No handler registered for method: ${method}`);
  return handler({ method, params }, extra);
}

function hasHandler(server: ReturnType<typeof createProxyServer>, method: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((server as any)._requestHandlers as Map<string, unknown>).has(method);
}

// ── capability mirroring ──────────────────────────────────────────────────

describe('createProxyServer() — capability edge cases', () => {
  it('builds a server even when upstream returns undefined capabilities', () => {
    const backend = makeRichBackend(undefined);

    const server = createProxyServer(backend);

    expect(hasHandler(server, 'tools/list')).toBe(false);
    expect(hasHandler(server, 'tools/call')).toBe(false);
    expect(hasHandler(server, 'resources/list')).toBe(false);
    expect(hasHandler(server, 'resources/read')).toBe(false);
    expect(hasHandler(server, 'prompts/list')).toBe(false);
    expect(hasHandler(server, 'prompts/get')).toBe(false);
    expect(backend.setNotificationHandler).not.toHaveBeenCalled();
  });

  it('mirrors tools without listChanged as {} (not {listChanged:true})', async () => {
    const backend = makeRichBackend({ tools: {} });
    const server = createProxyServer(backend);

    const result = (await invoke(server, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    })) as { capabilities: ServerCapabilities };

    expect(result.capabilities.tools).toEqual({});
    expect(backend.setNotificationHandler).not.toHaveBeenCalled();
  });

  it('does not register list-changed handlers when upstream lacks listChanged', () => {
    const backend = makeRichBackend({ tools: {}, resources: {}, prompts: {} });

    createProxyServer(backend);

    expect(backend.setNotificationHandler).not.toHaveBeenCalled();
  });
});

// ── notification fanout multi-proxy ───────────────────────────────────────

describe('createProxyServer() — shared notification bus', () => {
  it('registers backend handler exactly once for two proxies sharing one backend', () => {
    const backend = makeRichBackend({ tools: { listChanged: true } });

    createProxyServer(backend);
    createProxyServer(backend);

    const calls = (backend.setNotificationHandler as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([schema]) => schema === ToolListChangedNotificationSchema,
    );
    expect(calls).toHaveLength(1);
  });

  it('re-registers handler after all proxies close (bus is dropped)', async () => {
    const backend = makeRichBackend({ tools: { listChanged: true } });

    const a = createProxyServer(backend);
    a.onclose?.();

    // The bus should have been deleted; a fresh proxy registers a new handler.
    createProxyServer(backend);

    const calls = (backend.setNotificationHandler as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([schema]) => schema === ToolListChangedNotificationSchema,
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ── hidden / passthrough overlap ──────────────────────────────────────────

describe('createProxyServer() — hidden vs passthrough precedence', () => {
  it('hides a tool that is also in passThroughTools (hidden wins)', async () => {
    const backend = makeRichBackend({ tools: {} });
    const server = createProxyServer(backend, {
      hiddenTools: ['shared_name'],
      passThroughTools: ['shared_name'],
    });

    await expect(
      invoke(server, 'tools/call', { name: 'shared_name', arguments: {} }),
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it('returns the upstream list reference unchanged when hiddenTools is empty', async () => {
    const backend = makeRichBackend({ tools: {} });
    const upstream = { tools: [{ name: 't', description: '', inputSchema: { type: 'object', properties: {} } }] };
    (backend.listTools as ReturnType<typeof vi.fn>).mockResolvedValue(upstream);

    const server = createProxyServer(backend, { hiddenTools: [] });
    const result = await invoke(server, 'tools/list');

    expect(result).toBe(upstream);
  });
});

// ── createRequestOptions branches (asserted via backend args) ─────────────

describe('createProxyServer() — request options shapes', () => {
  it('passes undefined when neither signal nor progressToken is present', async () => {
    const backend = makeRichBackend({ tools: {} });
    const server = createProxyServer(backend);

    await invoke(server, 'tools/list');

    expect(backend.listTools).toHaveBeenCalledWith({}, undefined);
  });

  it('passes only { signal } when there is no progressToken', async () => {
    const backend = makeRichBackend({ tools: {} });
    const server = createProxyServer(backend);
    const controller = new AbortController();

    await invoke(server, 'tools/list', {}, { signal: controller.signal, requestId: 1 });

    expect(backend.listTools).toHaveBeenCalledWith(
      {},
      { signal: controller.signal },
    );
  });

  it('passes undefined when progressToken is present but sendNotification is missing', async () => {
    const backend = makeRichBackend({ tools: {} });
    const server = createProxyServer(backend);

    await invoke(
      server,
      'tools/list',
      {},
      { _meta: { progressToken: 'p1' }, requestId: 1 },
    );

    expect(backend.listTools).toHaveBeenCalledWith({}, undefined);
  });

  it('omits total/message from progress notifications when undefined', async () => {
    const backend = makeRichBackend({ tools: {} });
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    (backend.callTool as ReturnType<typeof vi.fn>).mockImplementation(async (_p, _s, options) => {
      options?.onprogress?.({ progress: 1 });
      return { content: [] };
    });

    const server = createProxyServer(backend);
    await invoke(
      server,
      'tools/call',
      { name: 'normal_tool', arguments: {} },
      { sendNotification, _meta: { progressToken: 'tok' }, requestId: 1 },
    );

    expect(sendNotification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 'tok', progress: 1 },
    });
    const call = sendNotification.mock.calls[0]?.[0] as { params: Record<string, unknown> };
    expect('total' in call.params).toBe(false);
    expect('message' in call.params).toBe(false);
  });
});

// ── tool middleware mutation safety ───────────────────────────────────────

describe('createProxyServer() — middleware behavior', () => {
  it('propagates errors from tool middleware to the caller', async () => {
    const backend = makeRichBackend({ tools: {} });
    const failing: ToolMiddleware = async () => {
      throw new Error('mw failure');
    };
    const server = createProxyServer(backend, { toolMiddleware: [failing] });

    await expect(
      invoke(server, 'tools/call', { name: 'normal_tool', arguments: {} }),
    ).rejects.toThrow('mw failure');
  });
});
