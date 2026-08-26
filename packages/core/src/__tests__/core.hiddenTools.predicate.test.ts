import { describe, it, expect, vi } from 'vitest';
import { createProxyServer } from '../core.js';
import { dispatcherAwareBlock } from '../hiddenTools.js';
import type { BackendClient } from '../backendClient.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ── Test helpers ────────────────────────────────────────────────────────────

const TOOLS = ['update_issue', 'search_issues', 'execute_sentry_tool'].map(
  (name) => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
  }),
);

function makeMockBackend(): BackendClient {
  return {
    getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
    listTools: vi.fn().mockResolvedValue({ tools: TOOLS }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'upstream response' }],
    }),
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

const blockUpdateIssue = () =>
  dispatcherAwareBlock({
    tools: ['update_issue'],
    dispatchers: ['execute_sentry_tool'],
    argPath: 'name',
  });

// ── The predicate in the proxy ──────────────────────────────────────────────

describe('createProxyServer() — hiddenTools accepts a predicate', () => {
  it('filters tools the predicate hides out of tools/list, with undefined args', async () => {
    const seen: Array<[string, unknown]> = [];
    const server = createProxyServer(makeMockBackend(), {
      hiddenTools: (name, args) => {
        seen.push([name, args]);
        return name === 'update_issue';
      },
    });

    const result = (await invokeHandler(server, 'tools/list')) as {
      tools: { name: string }[];
    };

    expect(result.tools.map((t) => t.name)).toEqual([
      'search_issues',
      'execute_sentry_tool',
    ]);
    expect(seen.every(([, args]) => args === undefined)).toBe(true);
  });

  it('rejects a call the predicate hides with TOOL_HIDDEN, upstream never called', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      hiddenTools: blockUpdateIssue(),
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'update_issue',
        arguments: {},
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
      data: { rejectionReason: 'TOOL_HIDDEN' },
    });
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('passes an empty object, not undefined, when the client sent no arguments', async () => {
    const seen: unknown[] = [];
    const server = createProxyServer(makeMockBackend(), {
      hiddenTools: (_name, args) => {
        seen.push(args);
        return false;
      },
    });

    await invokeHandler(server, 'tools/call', { name: 'search_issues' });
    expect(seen).toEqual([{}]);
  });
});

// ── dispatcherAwareBlock through the proxy ──────────────────────────────────

describe('createProxyServer() — dispatcherAwareBlock closes the dispatcher bypass', () => {
  it('blocks a dispatcher call targeting a hidden tool, upstream never called', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      hiddenTools: blockUpdateIssue(),
    });

    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'execute_sentry_tool',
        arguments: { name: 'update_issue', arguments: {} },
      }),
    ).rejects.toMatchObject({ data: { rejectionReason: 'TOOL_HIDDEN' } });
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('keeps the dispatcher listed and callable with a permitted target', async () => {
    const backend = makeMockBackend();
    const server = createProxyServer(backend, {
      hiddenTools: blockUpdateIssue(),
    });

    const listed = (await invokeHandler(server, 'tools/list')) as {
      tools: { name: string }[];
    };
    expect(listed.tools.map((t) => t.name)).toContain('execute_sentry_tool');

    const result = await invokeHandler(server, 'tools/call', {
      name: 'execute_sentry_tool',
      arguments: { name: 'search_issues', arguments: {} },
    });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'upstream response' }],
    });
  });
});

// ── dispatcherAwareBlock fail-closed cases ──────────────────────────────────

describe('dispatcherAwareBlock() — fails closed on malformed dispatcher calls', () => {
  const predicate = dispatcherAwareBlock({
    tools: ['update_issue'],
    dispatchers: ['dispatch'],
    argPath: 'request.tool.name',
  });

  it.each([
    ['missing target', {}],
    ['null target', { request: { tool: { name: null } } }],
    ['numeric target', { request: { tool: { name: 42 } } }],
    ['object target', { request: { tool: { name: { nested: true } } } }],
    ['array target', { request: { tool: { name: ['update_issue'] } } }],
    ['path through a non-object', { request: 'not-an-object' }],
    ['path through an array', { request: [{ tool: { name: 'x' } }] }],
  ])('blocks a dispatcher call with %s', (_label, args) => {
    expect(predicate('dispatch', args as Record<string, unknown>)).toBe(true);
  });

  it('blocks a dispatcher call with no arguments at all (call phase = empty object)', () => {
    expect(predicate('dispatch', {})).toBe(true);
  });

  it('does not resolve prototype keys such as constructor', () => {
    const proto = dispatcherAwareBlock({
      tools: ['update_issue'],
      dispatchers: ['dispatch'],
      argPath: 'constructor',
    });
    expect(proto('dispatch', {})).toBe(true);
  });

  it('allows a dispatcher call with a permitted string target', () => {
    expect(
      predicate('dispatch', { request: { tool: { name: 'search_issues' } } }),
    ).toBe(false);
  });

  it('blocks the hidden tool directly regardless of phase', () => {
    expect(predicate('update_issue', undefined)).toBe(true);
    expect(predicate('update_issue', {})).toBe(true);
  });

  it('keeps the dispatcher visible during the list phase', () => {
    expect(predicate('dispatch', undefined)).toBe(false);
  });

  it('ignores non-dispatcher, non-hidden tools', () => {
    expect(predicate('search_issues', { anything: 1 })).toBe(false);
  });
});
