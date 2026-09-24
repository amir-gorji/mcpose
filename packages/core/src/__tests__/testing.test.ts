import { describe, it, expect } from 'vitest';
import {
  runToolMiddleware,
  runListToolsMiddleware,
  runResourceMiddleware,
  createMockBackendClient,
} from '../testing.js';
import type {
  ListToolsMiddleware,
  ResourceMiddleware,
  ToolMiddleware,
} from '../core.js';
import type {
  CallToolRequest,
  ListToolsRequest,
  ReadResourceRequest,
} from '@modelcontextprotocol/sdk/types.js';

const callReq: CallToolRequest = {
  method: 'tools/call',
  params: { name: 'echo', arguments: {} },
};

const listReq: ListToolsRequest = { method: 'tools/list', params: {} };

const readReq: ReadResourceRequest = {
  method: 'resources/read',
  params: { uri: 'res://a' },
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
    const legacy: ToolMiddleware = async () => ({ toolResult: 'old' });

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

    await runToolMiddleware(capture, callReq, async () => ({ content: [] }), {
      requestId: 'abc-123',
      transport: 'stdio',
    });

    expect(seenRequestId).toBe('abc-123');
  });
});

describe('runListToolsMiddleware()', () => {
  it('runs the middleware with a fresh default ProxyContext — no cast needed', async () => {
    let seenRequestId: string | undefined;
    const capture: ListToolsMiddleware = async (req, next, context) => {
      seenRequestId = context.requestId;
      return next(req);
    };

    const result = await runListToolsMiddleware(capture, listReq, async () => ({
      tools: [],
    }));

    expect(result.tools).toEqual([]);
    expect(seenRequestId).toBeTruthy();
  });

  it('forwards a custom ProxyContext to the middleware', async () => {
    let seenRequestId: string | undefined;
    const capture: ListToolsMiddleware = async (req, next, context) => {
      seenRequestId = context.requestId;
      return next(req);
    };

    await runListToolsMiddleware(
      capture,
      listReq,
      async () => ({ tools: [] }),
      {
        requestId: 'abc-123',
        transport: 'stdio',
      },
    );

    expect(seenRequestId).toBe('abc-123');
  });
});

describe('runResourceMiddleware()', () => {
  it('runs the middleware with a fresh default ProxyContext — no cast needed', async () => {
    let seenRequestId: string | undefined;
    const capture: ResourceMiddleware = async (req, next, context) => {
      seenRequestId = context.requestId;
      return next(req);
    };

    const result = await runResourceMiddleware(capture, readReq, async () => ({
      contents: [{ uri: 'res://a', text: 'body' }],
    }));

    expect(result.contents[0]).toMatchObject({ text: 'body' });
    expect(seenRequestId).toBeTruthy();
  });

  it('forwards a custom ProxyContext to the middleware', async () => {
    let seenRequestId: string | undefined;
    const capture: ResourceMiddleware = async (req, next, context) => {
      seenRequestId = context.requestId;
      return next(req);
    };

    await runResourceMiddleware(
      capture,
      readReq,
      async () => ({
        contents: [],
      }),
      {
        requestId: 'abc-123',
        transport: 'stdio',
      },
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
    expect((result.content as { text: string }[])[0]).toMatchObject({
      text: 'static',
    });
  });

  it('passes the call params to a factory callToolResponse', async () => {
    let seen:
      | { name: string; arguments?: Record<string, unknown> | undefined }
      | undefined;
    const backend = createMockBackendClient({
      callToolResponse: (params) => {
        seen = params;
        return { content: [{ type: 'text', text: `got:${params.name}` }] };
      },
    });

    const result = await backend.callTool({
      name: 'echo',
      arguments: { a: 1 },
    });

    expect(seen?.name).toBe('echo');
    expect(seen?.arguments).toEqual({ a: 1 });
    expect((result.content as { text: string }[])[0]).toMatchObject({
      text: 'got:echo',
    });
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
      tools: [
        {
          name: 't',
          description: 'd',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    const result = await backend.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe('t');
  });
});

describe('createMockBackendClient() fixtures', () => {
  it('serves documented defaults when no fixtures are given', async () => {
    const backend = createMockBackendClient();
    expect(await backend.callTool({ name: 'x', arguments: {} })).toEqual({
      content: [{ type: 'text', text: 'mock response' }],
    });
    expect(await backend.listTools()).toEqual({ tools: [] });
    expect(await backend.listResources()).toEqual({ resources: [] });
    expect(await backend.readResource({ uri: 'res://a' })).toEqual({
      contents: [{ uri: '', text: 'mock resource' }],
    });
    expect(await backend.listPrompts()).toEqual({ prompts: [] });
    expect(await backend.getPrompt({ name: 'p' })).toEqual({ messages: [] });
  });

  it('serves supplied resource and prompt fixtures', async () => {
    const backend = createMockBackendClient({
      capabilities: { tools: {} },
      resources: [{ uri: 'res://a', name: 'a' }],
      readResourceResponse: { contents: [{ uri: 'res://a', text: 'body' }] },
      prompts: [{ name: 'p' }],
      getPromptResponse: {
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
      },
    });
    expect(backend.getServerCapabilities()).toEqual({ tools: {} });
    expect((await backend.listResources()).resources).toEqual([
      { uri: 'res://a', name: 'a' },
    ]);
    expect((await backend.readResource({ uri: 'res://a' })).contents).toEqual([
      { uri: 'res://a', text: 'body' },
    ]);
    expect((await backend.listPrompts()).prompts).toEqual([{ name: 'p' }]);
    expect((await backend.getPrompt({ name: 'p' })).messages).toHaveLength(1);
  });

  it('clones fixtures per call so a mutating caller cannot corrupt them', async () => {
    const backend = createMockBackendClient({
      resources: [{ uri: 'res://a', name: 'a' }],
    });
    (await backend.listResources()).resources.pop();
    expect((await backend.listResources()).resources).toHaveLength(1);
  });
});
