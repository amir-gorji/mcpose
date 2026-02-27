/** MCP proxy core: wires server→upstream through middleware pipelines. */
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolRequest,
  type CallToolResult,
  type CompatibilityCallToolResult,
  type ReadResourceRequest,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { pipe, type Middleware } from './middleware.js';
import type { BackendClient } from './backendClient.js';

/**
 * Middleware for tool calls.
 * Uses `CompatibilityCallToolResult` to cover legacy `{ toolResult }` shape
 * (protocol 2024-10-07). Narrow with `hasToolContent()` before accessing `.content`.
 */
export type ToolMiddleware = Middleware<
  CallToolRequest,
  CompatibilityCallToolResult
>;

/** Middleware for resource reads. */
export type ResourceMiddleware = Middleware<
  ReadResourceRequest,
  ReadResourceResult
>;

/**
 * Narrows `CompatibilityCallToolResult` to `CallToolResult` (has `.content` array).
 * Both union members carry `[x: string]: unknown`, so this avoids unsafe casts.
 */
export function hasToolContent(
  r: CompatibilityCallToolResult,
): r is CallToolResult {
  return Array.isArray(r.content);
}

/** HTTP transport options for {@link startHttpProxy}. */
export interface HttpProxyOptions {
  /** Default: 3000 */
  port?: number;
  /** Default: all interfaces */
  host?: string;
  /** Default: '/mcp' */
  path?: string;
}

/** Proxy server options. */
export interface ProxyOptions {
  /**
   * Tool middleware in response-processing order (first = innermost).
   * @example [piiMW, auditMW]  // pii redacts first, audit logs clean data
   */
  toolMiddleware?: ReadonlyArray<ToolMiddleware>;

  /** Resource middleware in response-processing order (first = innermost). */
  resourceMiddleware?: ReadonlyArray<ResourceMiddleware>;

  /** Tools that skip middleware — upstream response forwarded as-is. */
  passThroughTools?: ReadonlyArray<string>;

  /** Resources that skip middleware — upstream response forwarded as-is. */
  passThroughResources?: ReadonlyArray<string>;

  /** Tools hidden from list_tools and rejected at runtime with MethodNotFound. */
  hiddenTools?: ReadonlyArray<string>;

  /** Resources hidden from list_resources and rejected at runtime with InvalidRequest. */
  hiddenResources?: ReadonlyArray<string>;
}

/**
 * Creates a proxy MCP server without connecting it to a transport.
 *
 * Mirrors upstream tool/resource/prompt lists and routes requests through
 * middleware pipelines. Prompts are forwarded as-is.
 *
 * Uses low-level `Server` (not `McpServer`) — transparent proxying requires
 * generic list interception; `McpServer.tool()` needs names upfront.
 *
 * @param backend - Connected (or mock) upstream MCP client.
 * @param options - Middleware stacks, hidden/passthrough sets.
 * @returns Configured {@link Server} ready to connect.
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
 * Starts the proxy on stdio.
 * Calls {@link createProxyServer} then connects to `StdioServerTransport`.
 * Use `createProxyServer` directly for testable access to the server.
 */
export async function startProxy(
  backend: BackendClient,
  options: ProxyOptions = {},
): Promise<void> {
  const server = createProxyServer(backend, options);
  await server.connect(new StdioServerTransport());
}

/**
 * Starts the proxy over Streamable HTTP with stateful sessions.
 *
 * Sessions keyed by `mcp-session-id`. Upstream notifications fanned out to
 * all active sessions via their GET SSE stream.
 *
 * **Limitations:**
 * - Two calls with same `backend` overwrite notification handlers (last wins).
 * - Sessions never expire — only cleaned up on DELETE or server close.
 * - No `EventStore` → SSE reconnect replay unsupported.
 *
 * @returns Promise resolving to the listening `http.Server`.
 */
export function startHttpProxy(
  backend: BackendClient,
  options: ProxyOptions = {},
  httpOptions: HttpProxyOptions = {},
): Promise<http.Server> {
  const mcpPath = httpOptions.path ?? '/mcp';
  const port    = httpOptions.port ?? 3000;
  const host    = httpOptions.host;

  // session ID → { transport, proxyServer }
  const sessions = new Map<string, {
    transport: StreamableHTTPServerTransport;
    proxyServer: Server;
  }>();

  // Fan upstream notifications to all active sessions' SSE streams.
  backend.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    await Promise.all([...sessions.values()].map(({ proxyServer }) => proxyServer.sendToolListChanged()));
  });
  backend.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
    await Promise.all([...sessions.values()].map(({ proxyServer }) => proxyServer.sendPromptListChanged()));
  });
  backend.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
    await Promise.all([...sessions.values()].map(({ proxyServer }) => proxyServer.sendResourceListChanged()));
  });

  const server = http.createServer((req, res) => {
    const handle = async () => {
      const url    = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? '';

      if (url.pathname !== mcpPath || !['GET', 'POST', 'DELETE'].includes(method)) {
        res.writeHead(404).end();
        return;
      }

      const sessionId = req.headers['mcp-session-id'];

      if (typeof sessionId === 'string') {
        // Route to existing session
        const session = sessions.get(sessionId);
        if (!session) { res.writeHead(404).end(); return; }
        await session.transport.handleRequest(req, res);
      } else {
        // New session (initialize request)
        const proxyServer = createProxyServer(backend, options);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => { sessions.set(id, { transport, proxyServer }); },
          onsessionclosed:      (id) => { sessions.delete(id); },
        });
        await proxyServer.connect(transport);
        await transport.handleRequest(req, res);
      }
    };

    handle().catch((err) => {
      if (!res.headersSent) res.writeHead(500).end();
      void err;
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, ...(host ? [host] : []), () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
