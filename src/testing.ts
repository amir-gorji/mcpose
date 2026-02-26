/**
 * Framework-agnostic test helpers for code that uses mcpose middleware.
 *
 * **No test framework imports** — this module has zero dependencies on
 * vitest, jest, or mocha. Import it in any test environment.
 *
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
} from '@modelcontextprotocol/sdk/types.js';
import { hasToolContent } from './core.js';
import type { ToolMiddleware } from './core.js';
import type { BackendClient } from './backendClient.js';

// ---------------------------------------------------------------------------
// Pain Point 1: runToolMiddleware
// ---------------------------------------------------------------------------

/**
 * Calls a {@link ToolMiddleware} and narrows the result to {@link CallToolResult}.
 *
 * Eliminates the boilerplate `isCallToolResult` guard that every test of a
 * `ToolMiddleware` must otherwise repeat. Throws a clear error if the upstream
 * returns the legacy `{ toolResult }` protocol shape.
 *
 * @param mw   - The middleware under test.
 * @param req  - The tool call request to pass in.
 * @param next - The innermost handler (simulates the upstream or next middleware).
 *
 * @example
 * ```ts
 * const result = await runToolMiddleware(mw, req, async () => mockResult);
 * expect(result.content[0]).toMatchObject({ type: 'text' });
 * ```
 */
export async function runToolMiddleware(
  mw: ToolMiddleware,
  req: CallToolRequest,
  next: (req: CallToolRequest) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const result = await mw(req, next);
  if (!hasToolContent(result)) {
    throw new Error(
      'runToolMiddleware: middleware returned legacy toolResult shape — expected { content: [...] }',
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pain Point 2: createMockBackendClient
// ---------------------------------------------------------------------------

/**
 * Configuration for the mock backend client.
 */
export interface MockBackendClientOptions {
  /** Tools advertised by the mock upstream. Default: `[]`. */
  tools?: Tool[];
  /**
   * Response for `callTool`. Can be a static result or a factory function
   * that receives the call params and returns a per-call result.
   *
   * Default: `{ content: [{ type: 'text', text: 'mock response' }] }`
   */
  callToolResponse?:
    | CallToolResult
    | ((params: CallToolRequestParams) => CallToolResult);
  /** Resources advertised by the mock upstream. Default: `[]`. */
  resources?: Resource[];
  /**
   * Response for `readResource`.
   *
   * Default: `{ contents: [{ uri: '', text: 'mock resource' }] }`
   */
  readResourceResponse?: ReadResourceResult;
  /** Prompts advertised by the mock upstream. Default: `[]`. */
  prompts?: Prompt[];
  /**
   * Response for `getPrompt`.
   *
   * Default: `{ messages: [] }`
   */
  getPromptResponse?: GetPromptResult;
}

/**
 * Creates a plain object implementing {@link BackendClient} for use in tests.
 *
 * No real process is spawned and no network connection is made. All methods
 * return configurable in-memory responses, making it possible to test the full
 * `compose([auditMW, piiMW])` pipeline in a unit test.
 *
 * @example
 * ```ts
 * const backend = createMockBackendClient({
 *   callToolResponse: { content: [{ type: 'text', text: 'John Doe: 123-45-6789' }] },
 * });
 * // Now compose real middlewares against it:
 * const pipeline = compose([auditMW, piiToolMW]);
 * const result = await pipeline(req, (r) => backend.callTool(r.params, undefined));
 * ```
 */
export function createMockBackendClient(
  options: MockBackendClientOptions = {},
): BackendClient {
  return {
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
  } as unknown as BackendClient;
}
