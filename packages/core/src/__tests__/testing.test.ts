import { describe, it, expect } from 'vitest';
import { runToolMiddleware, createMockBackendClient } from '../testing.js';
import type { ToolMiddleware } from '../core.js';
import type {
  CallToolRequest,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

const callReq: CallToolRequest = {
  method: 'tools/call',
  params: { name: 'echo', arguments: {} },
};

describe('runToolMiddleware()', () => {
  it('returns the narrowed CallToolResult when middleware produces { content: [...] }', async () => {
    const passthrough: ToolMiddleware = (req, next) => next(req);
    const result = await runToolMiddleware(passthrough, callReq, async () => ({
      content: [{ type: 'text', text: 'hi' }],
    }));
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'hi' });
  });

  it('accepts an empty content array', async () => {
    const passthrough: ToolMiddleware = (req, next) => next(req);
    const result = await runToolMiddleware(passthrough, callReq, async () => ({
      content: [],
    }));
    expect(result.content).toEqual([]);
  });

  it('throws when middleware returns the legacy { toolResult } shape', async () => {
    const legacy: ToolMiddleware = async () =>
      ({ toolResult: 'old' } as unknown as CallToolResult);

    await expect(
      runToolMiddleware(legacy, callReq, async () => ({ content: [] })),
    ).rejects.toThrow(/legacy toolResult shape/);
  });

  it('forwards a custom ProxyContext to the middleware', async () => {
    let seenRequestId: string | undefined;
    const capture: ToolMiddleware = async (req, next, context) => {
      seenRequestId = context.requestId;
      return next(req);
    };

    await runToolMiddleware(
      capture,
      callReq,
      async () => ({ content: [] }),
      { requestId: 'abc-123', transport: 'stdio' },
    );

    expect(seenRequestId).toBe('abc-123');
  });
});

describe('createMockBackendClient()', () => {
  it('returns the static callToolResponse when provided', async () => {
    const backend = createMockBackendClient({
      callToolResponse: { content: [{ type: 'text', text: 'static' }] },
    });
    const result = await backend.callTool({ name: 'x', arguments: {} });
    expect((result.content as { text: string }[])[0]).toMatchObject({ text: 'static' });
  });

  it('passes the call params to a factory callToolResponse', async () => {
    let seen: { name: string; arguments?: Record<string, unknown> } | undefined;
    const backend = createMockBackendClient({
      callToolResponse: (params) => {
        seen = params as typeof seen;
        return { content: [{ type: 'text', text: `got:${params.name}` }] };
      },
    });

    const result = await backend.callTool({ name: 'echo', arguments: { a: 1 } });

    expect(seen?.name).toBe('echo');
    expect(seen?.arguments).toEqual({ a: 1 });
    expect((result.content as { text: string }[])[0]).toMatchObject({ text: 'got:echo' });
  });

  it('defaults capabilities to all three scopes', () => {
    const backend = createMockBackendClient();
    expect(backend.getServerCapabilities()).toEqual({
      tools: {},
      resources: {},
      prompts: {},
    });
  });

  it('exposes user-supplied tools verbatim', async () => {
    const backend = createMockBackendClient({
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    });
    const result = await backend.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe('t');
  });
});
