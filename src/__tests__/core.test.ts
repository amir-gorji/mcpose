import { describe, it, expect, vi } from 'vitest';
import { createProxyServer, type ToolMiddleware } from '../core.js';
import type { BackendClient } from '../backendClient.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeMockBackend(): BackendClient {
  return {
    listTools: vi.fn().mockResolvedValue({
      tools: [
        { name: 'normal_tool', description: 'Normal', inputSchema: { type: 'object', properties: {} } },
        { name: 'sensitive_tool', description: 'Sensitive', inputSchema: { type: 'object', properties: {} } },
        { name: 'pass_tool', description: 'Pass-through', inputSchema: { type: 'object', properties: {} } },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'raw upstream response' }],
    }),
    listResources: vi.fn().mockResolvedValue({
      resources: [
        { name: 'Normal Resource', uri: 'res://normal', mimeType: 'text/plain' },
        { name: 'Hidden Resource', uri: 'res://hidden', mimeType: 'text/plain' },
        { name: 'Pass Resource', uri: 'res://pass', mimeType: 'text/plain' },
      ],
    }),
    readResource: vi.fn().mockResolvedValue({
      contents: [{ uri: 'res://normal', text: 'raw content', mimeType: 'text/plain' }],
    }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
  } as unknown as BackendClient;
}

/** Invokes a registered handler directly via `_requestHandlers` — no transport needed. */
async function invokeHandler(
  server: ReturnType<typeof createProxyServer>,
  method: string,
  params: Record<string, unknown> = {},
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = (server as any)._requestHandlers as Map<
    string,
    (req: { method: string; params: Record<string, unknown> }, extra: object) => Promise<unknown>
  >;
  const handler = handlers.get(method);
  if (!handler) throw new Error(`No handler registered for method: ${method}`);
  return handler({ method, params }, {});
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createProxyServer() — hiddenTools', () => {
  it('filters hidden tools out of list_tools response', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { hiddenTools: ['sensitive_tool'] });

    const result = (await invokeHandler(server, 'tools/list')) as { tools: { name: string }[] };

    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain('sensitive_tool');
    expect(names).toContain('normal_tool');
    expect(names).toContain('pass_tool');
  });

  it('throws MethodNotFound when a hidden tool is called directly', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { hiddenTools: ['sensitive_tool'] });

    await expect(
      invokeHandler(server, 'tools/call', { name: 'sensitive_tool', arguments: {} }),
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it('returns full tool list when hiddenTools is empty', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { hiddenTools: [] });

    const result = (await invokeHandler(server, 'tools/list')) as { tools: { name: string }[] };
    expect(result.tools).toHaveLength(3);
  });
});

describe('createProxyServer() — passThroughTools', () => {
  it('bypasses middleware for pass-through tools (middleware spy not called)', async () => {
    const backend = makeMockBackend();
    const middlewareSpy = vi.fn<ToolMiddleware>((req, next) => next(req));
    const server = createProxyServer(backend, {
      passThroughTools: ['pass_tool'],
      toolMiddleware: [middlewareSpy],
    });

    await invokeHandler(server, 'tools/call', { name: 'pass_tool', arguments: {} });

    expect(middlewareSpy).not.toHaveBeenCalled();
  });

  it('returns the raw upstream response for pass-through tools', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { passThroughTools: ['pass_tool'] });

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
    });

    await invokeHandler(server, 'tools/call', { name: 'normal_tool', arguments: {} });

    expect(middlewareSpy).toHaveBeenCalledOnce();
  });
});

describe('createProxyServer() — hiddenResources', () => {
  it('filters hidden resources out of list_resources response', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { hiddenResources: ['res://hidden'] });

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
    const server = createProxyServer(backend, { hiddenResources: ['res://hidden'] });

    await expect(
      invokeHandler(server, 'resources/read', { uri: 'res://hidden' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  it('returns full resource list when hiddenResources is empty', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { hiddenResources: [] });

    const result = (await invokeHandler(server, 'resources/list')) as {
      resources: { uri: string }[];
    };
    expect(result.resources).toHaveLength(3);
  });
});

describe('createProxyServer() — passThroughResources', () => {
  it('bypasses middleware for pass-through resources', async () => {
    const backend = makeMockBackend();
    const middlewareSpy = vi.fn((req: unknown, next: (r: unknown) => Promise<unknown>) =>
      next(req),
    );
    const server = createProxyServer(backend, {
      passThroughResources: ['res://pass'],
      resourceMiddleware: [middlewareSpy as never],
    });

    await invokeHandler(server, 'resources/read', { uri: 'res://pass' });

    expect(middlewareSpy).not.toHaveBeenCalled();
  });

  it('returns the raw upstream response for pass-through resources', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, { passThroughResources: ['res://pass'] });

    const result = (await invokeHandler(server, 'resources/read', {
      uri: 'res://pass',
    })) as { contents: { text: string }[] };

    expect(result.contents[0]?.text).toBe('raw content');
  });
});
