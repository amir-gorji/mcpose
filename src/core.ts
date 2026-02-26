/**
 * Generic MCP proxy core.
 *
 * Wires an MCP server (exposed to the LLM) to an upstream MCP client,
 * applying composed middleware pipelines to tool calls and resource reads.
 *
 * @module
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type CompatibilityCallToolResult,
  type ReadResourceRequest,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { pipe, type Middleware } from './middleware.js';
import type { BackendClient } from './backendClient.js';

/**
 * Middleware for MCP tool calls.
 *
 * Uses `CompatibilityCallToolResult` because `Client.callTool()` returns a
 * union that includes the legacy `{ toolResult }` shape (protocol 2024-10-07).
 * Middleware implementations should narrow with `hasToolContent(result)` before
 * accessing `.content` or `.isError`.
 */
export type ToolMiddleware = Middleware<
  CallToolRequest,
  CompatibilityCallToolResult
>;

/** Middleware for MCP resource reads. */
export type ResourceMiddleware = Middleware<
  ReadResourceRequest,
  ReadResourceResult
>;

/**
 * Type guard that narrows a {@link CompatibilityCallToolResult} to the modern
 * {@link CallToolResult} shape (i.e. the result has a `content` array).
 *
 * Use this in middleware implementations to safely access `.content` and
 * `.isError` without casts, since both union members carry an index signature
 * (`[x: string]: unknown`) that would otherwise make property access `unknown`.
 */
export function hasToolContent(
  r: CompatibilityCallToolResult,
): r is CallToolResult {
  return Array.isArray(r.content);
}

/** Options for the proxy server. */
export interface ProxyOptions {
  /**
   * Ordered middleware stack for tool calls in response-processing order.
   * The first element processes the response first (innermost layer).
   * `pipe()` is called internally — no need to wrap manually.
   *
   * @example
   * toolMiddleware: [piiMW, auditMW]  // pii redacts first, audit logs clean data
   */
  toolMiddleware?: ReadonlyArray<ToolMiddleware>;

  /**
   * Ordered middleware stack for resource reads in response-processing order.
   * The first element processes the response first (innermost layer).
   */
  resourceMiddleware?: ReadonlyArray<ResourceMiddleware>;

  /** Tool names that bypass all middleware — raw upstream response forwarded as-is. */
  passThroughTools?: ReadonlyArray<string>;

  /** Resource URIs that bypass all middleware — raw upstream response forwarded as-is. */
  passThroughResources?: ReadonlyArray<string>;

  /** Tool names hidden from list_tools AND rejected at runtime with MethodNotFound. */
  hiddenTools?: ReadonlyArray<string>;

  /** Resource URIs hidden from list_resources AND rejected at runtime with InvalidRequest. */
  hiddenResources?: ReadonlyArray<string>;
}

/**
 * Creates and wires a proxy MCP server without connecting it to a transport.
 *
 * Mirrors the upstream's tool/resource/prompt list and registers request
 * handlers that route through the provided middleware pipelines. Prompts are
 * forwarded as-is (no middleware applied).
 *
 * Separating creation from connection makes the server fully testable: tests
 * can call `createProxyServer(mockUpstream, options)` and inspect or invoke
 * the registered handlers without spawning a stdio transport.
 *
 * @param upstream - Connected (or mock) upstream MCP client.
 * @param options  - Optional middleware stacks for tools and resources.
 * @returns A configured {@link Server} that is ready to be connected.
 */
export function createProxyServer(
  backend: BackendClient,
  options: ProxyOptions = {},
): Server {
  const toolPipeline = pipe(options.toolMiddleware ?? []);
  const resourcePipeline = pipe(options.resourceMiddleware ?? []);

  const hiddenToolSet = new Set(options.hiddenTools ?? []);
  const passThroughToolSet = new Set(options.passThroughTools ?? []);
  const hiddenResourceSet = new Set(options.hiddenResources ?? []);
  const passThroughResourceSet = new Set(options.passThroughResources ?? []);

  // NOTE: Using the low-level Server intentionally — a transparent proxy must
  // intercept list_tools / list_resources generically without knowing tool names
  // upfront. McpServer.tool() requires pre-registering each tool by name, which
  // breaks dynamic forwarding. The SDK explicitly carves out this pattern:
  // "Only use Server for advanced use cases."
  const server = new Server(
    { name: 'mcpose', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // ── Tool handlers ──────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await backend.listTools();
    if (!hiddenToolSet.size) return result;
    return { ...result, tools: result.tools.filter((t) => !hiddenToolSet.has(t.name)) };
  });

  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const name = req.params.name;
    if (hiddenToolSet.has(name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }
    if (passThroughToolSet.has(name)) {
      return backend.callTool(req.params, undefined);
    }
    return toolPipeline(req, (r) => backend.callTool(r.params, undefined));
  });

  // ── Resource handlers ──────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const result = await backend.listResources();
    if (!hiddenResourceSet.size) return result;
    return { ...result, resources: result.resources.filter((r) => !hiddenResourceSet.has(r.uri)) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, (req) => {
    const uri = req.params.uri;
    if (hiddenResourceSet.has(uri)) {
      throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${uri}`);
    }
    if (passThroughResourceSet.has(uri)) {
      return backend.readResource(req.params);
    }
    return resourcePipeline(req, (r) => backend.readResource(r.params));
  });

  // ── Prompt handlers (pass-through) ────────────────────────────────────────

  server.setRequestHandler(ListPromptsRequestSchema, () =>
    backend.listPrompts(),
  );

  server.setRequestHandler(GetPromptRequestSchema, (req) =>
    backend.getPrompt(req.params),
  );

  return server;
}

/**
 * Starts the proxy MCP server on stdio.
 *
 * Convenience wrapper that calls {@link createProxyServer} then connects the
 * result to a `StdioServerTransport`. Use `createProxyServer` directly when
 * you need a testable handle to the configured server.
 *
 * @param upstream - Connected upstream MCP client.
 * @param options  - Optional middleware stacks for tools and resources.
 */
export async function startProxy(
  backend: BackendClient,
  options: ProxyOptions = {},
): Promise<void> {
  const server = createProxyServer(backend, options);
  await server.connect(new StdioServerTransport());
}
