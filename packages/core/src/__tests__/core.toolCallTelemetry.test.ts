import { describe, it, expect, vi } from 'vitest';
import { createProxyServer, type LocalTool } from '../core.js';
import type { BackendClient } from '../backendClient.js';
import type { TelemetryEvent } from '../telemetry.js';

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

function makeBackend(): BackendClient {
  return {
    getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn(),
    setNotificationHandler: vi.fn(),
  } as unknown as BackendClient;
}

/**
 * `hasToolContent` answers false for a value that is not a tool result instead
 * of throwing on it. The `tools/call` telemetry decision reads that guard, so a
 * pipeline that resolved to nothing must not be recorded as a clean call: the
 * result never reached the client, and there is no `isError` to judge it by.
 */
describe('tools/call telemetry — a result that is not a tool result', () => {
  it('reports error when a local tool handler resolves to nothing', async () => {
    const events: TelemetryEvent[] = [];
    const noReturn: LocalTool = {
      tool: {
        name: 'silent_tool',
        description: 'returns undefined',
        inputSchema: { type: 'object', properties: {} },
      },
      // A local tool with a missing `return`: the pipeline resolves to undefined.
      handler: (async () => undefined) as unknown as LocalTool['handler'],
    };

    const server = createProxyServer(
      { crm: makeBackend() },
      {
        name: 'test-server',
        localTools: [noReturn],
        onTelemetry: (e) => events.push(e),
      },
    );

    // The SDK rejects the malformed result on the way out, which is correct and
    // unchanged by this PR. What matters is what telemetry recorded first.
    await expect(
      invokeHandler(server, 'tools/call', {
        name: 'silent_tool',
        arguments: {},
      }),
    ).rejects.toBeDefined();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_call',
      tool: 'silent_tool',
      outcome: 'error',
    });
  });

  it('still reports success for a real result and error for an isError one', async () => {
    const events: TelemetryEvent[] = [];
    const ok: LocalTool = {
      tool: {
        name: 'ok_tool',
        description: 'ok',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => ({ content: [{ type: 'text', text: 'fine' }] }),
    };
    const failing: LocalTool = {
      tool: {
        name: 'bad_tool',
        description: 'bad',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => ({
        content: [{ type: 'text', text: 'nope' }],
        isError: true,
      }),
    };

    const server = createProxyServer(
      { crm: makeBackend() },
      {
        name: 'test-server',
        localTools: [ok, failing],
        onTelemetry: (e) => events.push(e),
      },
    );

    await invokeHandler(server, 'tools/call', {
      name: 'ok_tool',
      arguments: {},
    });
    await invokeHandler(server, 'tools/call', {
      name: 'bad_tool',
      arguments: {},
    });

    expect(events.map((e) => (e as { outcome?: string }).outcome)).toEqual([
      'success',
      'error',
    ]);
  });
});

/**
 * The legacy `{ toolResult }` shape (protocol 2024-10-07) is a valid, documented
 * result — `mapToolResult` returns it untouched and the guard answers `false` for
 * it because it has no `.content`. It is not a failure, so it must not be
 * telemetered as one.
 */
describe('tools/call telemetry — the legacy { toolResult } shape', () => {
  it('reports success for a legacy-shape result', async () => {
    const events: TelemetryEvent[] = [];
    const backend = makeBackend();
    backend.callTool = vi.fn().mockResolvedValue({
      toolResult: { raw: true },
    }) as BackendClient['callTool'];

    const server = createProxyServer(
      { crm: backend },
      { name: 'test-server', onTelemetry: (e) => events.push(e) },
    );

    await invokeHandler(server, 'tools/call', {
      name: 'crm__legacy_tool',
      arguments: {},
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_call',
      outcome: 'success',
    });
  });
});
