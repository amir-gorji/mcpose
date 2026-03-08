/**
 * Test helpers for mcpose middleware. No test framework imports — works in any env.
 * @module mcpose/testing
 */
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
  ListResourcesResult,
  ListPromptsResult,
  ReadResourceResult,
  Tool,
  Resource,
  Prompt,
  CallToolRequestParams,
  ReadResourceRequestParams,
  GetPromptRequestParams,
  GetPromptResult,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import { hasToolContent } from './core.js';
import type { ToolMiddleware } from './core.js';
import type { BackendClient } from './backendClient.js';
import { createProxyContext, type ProxyContext } from './proxyContext.js';

/**
 * Runs a `ToolMiddleware` and narrows result to `CallToolResult`.
 * Throws if upstream returns legacy `{ toolResult }` shape.
 *
 * @example
 * const result = await runToolMiddleware(mw, req, async () => mockResult);
 * expect(result.content[0]).toMatchObject({ type: 'text' });
 */
export async function runToolMiddleware(
  mw: ToolMiddleware,
  req: CallToolRequest,
  next: (req: CallToolRequest) => Promise<CallToolResult>,
  context: ProxyContext = createProxyContext(),
): Promise<CallToolResult> {
  const result = await mw(req, next, context);
  if (!hasToolContent(result)) {
    throw new Error(
      'runToolMiddleware: middleware returned legacy toolResult shape — expected { content: [...] }',
    );
  }
  return result;
}

/** Config for mock backend client. */
export interface MockBackendClientOptions {
  /** Default: tools/resources/prompts enabled */
  capabilities?: ServerCapabilities;
  /** Default: `[]` */
  tools?: Tool[];
  /**
   * Static result or factory `(params) => result` for `callTool`.
   * Default: `{ content: [{ type: 'text', text: 'mock response' }] }`
   */
  callToolResponse?:
    | CallToolResult
    | ((params: CallToolRequestParams) => CallToolResult);
  /** Default: `[]` */
  resources?: Resource[];
  /** Default: `{ contents: [{ uri: '', text: 'mock resource' }] }` */
  readResourceResponse?: ReadResourceResult;
  /** Default: `[]` */
  prompts?: Prompt[];
  /** Default: `{ messages: [] }` */
  getPromptResponse?: GetPromptResult;
}

/**
 * Creates an in-memory `BackendClient` for unit tests. No process/network.
 *
 * @example
 * const backend = createMockBackendClient({
 *   callToolResponse: { content: [{ type: 'text', text: 'John Doe: 123-45-6789' }] },
 * });
 * const pipeline = compose([auditMW, piiToolMW]);
 * const result = await pipeline(req, (r) => backend.callTool(r.params, undefined));
 */
export function createMockBackendClient(
  options: MockBackendClientOptions = {},
): BackendClient {
  const capabilities = options.capabilities ?? {
    tools: {},
    resources: {},
    prompts: {},
  };

  return {
    getServerCapabilities: (): ServerCapabilities => capabilities,

    listTools: async (): Promise<ListToolsResult> => ({
      tools: options.tools ?? [],
    }),

    callTool: async (
      params: CallToolRequestParams,
    ): Promise<CallToolResult> => {
      const resp = options.callToolResponse;
      if (typeof resp === 'function') return resp(params);
      return resp ?? { content: [{ type: 'text', text: 'mock response' }] };
    },

    listResources: async (): Promise<ListResourcesResult> => ({
      resources: options.resources ?? [],
    }),

    readResource: async (
      _params: ReadResourceRequestParams,
    ): Promise<ReadResourceResult> =>
      options.readResourceResponse ?? {
        contents: [{ uri: '', text: 'mock resource' }],
      },

    listPrompts: async (): Promise<ListPromptsResult> => ({
      prompts: options.prompts ?? [],
    }),

    getPrompt: async (
      _params: GetPromptRequestParams,
    ): Promise<GetPromptResult> =>
      options.getPromptResponse ?? { messages: [] },

    setNotificationHandler: () => undefined,
    removeNotificationHandler: () => undefined,
    close: async () => undefined,
  } as unknown as BackendClient;
}
