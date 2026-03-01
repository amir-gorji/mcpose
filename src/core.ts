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
  type ServerCapabilities,
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

type ProgressToken = string | number;
type BackendRequestOptions = Parameters<BackendClient['listTools']>[1];
type ProxyRequestExtra = {
  signal?: AbortSignal;
  _meta?: { progressToken?: ProgressToken };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: ProgressToken;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
};

type ListChangedBus = {
  servers: Set<Server>;
};

const listChangedBuses = new WeakMap<BackendClient, ListChangedBus>();

function createProxyCapabilities(backend: BackendClient): ServerCapabilities {
  const upstream = backend.getServerCapabilities();

  return {
    ...(upstream?.tools
      ? { tools: upstream.tools.listChanged ? { listChanged: true } : {} }
      : {}),
    ...(upstream?.resources
      ? { resources: upstream.resources.listChanged ? { listChanged: true } : {} }
      : {}),
    ...(upstream?.prompts
      ? { prompts: upstream.prompts.listChanged ? { listChanged: true } : {} }
      : {}),
  };
}

function createRequestOptions(
  extra: ProxyRequestExtra = {},
): BackendRequestOptions {
  const progressToken = extra._meta?.progressToken;
  const onprogress = progressToken && extra.sendNotification
    ? ({
        progress,
        total,
        message,
      }: {
        progress: number;
        total?: number;
        message?: string;
      }) => {
        void extra.sendNotification?.({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress,
            ...(total === undefined ? {} : { total }),
            ...(message === undefined ? {} : { message }),
          },
        });
      }
    : undefined;

  if (!extra.signal && !onprogress) return undefined;

  return {
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(onprogress ? { onprogress } : {}),
  };
}

function registerListChangedForwarders(
  backend: BackendClient,
  server: Server,
  capabilities: ServerCapabilities,
): void {
  if (
    !capabilities.tools?.listChanged &&
    !capabilities.resources?.listChanged &&
    !capabilities.prompts?.listChanged
  ) {
    return;
  }

  let bus = listChangedBuses.get(backend);

  if (!bus) {
    const servers = new Set<Server>();
    const fanOut = async (
      notify: (proxyServer: Server) => Promise<void>,
    ): Promise<void> => {
      await Promise.allSettled([...servers].map((proxyServer) => notify(proxyServer)));
    };

    if (capabilities.tools?.listChanged) {
      backend.setNotificationHandler(ToolListChangedNotificationSchema, () =>
        fanOut((proxyServer) => proxyServer.sendToolListChanged()),
      );
    }

    if (capabilities.prompts?.listChanged) {
      backend.setNotificationHandler(PromptListChangedNotificationSchema, () =>
        fanOut((proxyServer) => proxyServer.sendPromptListChanged()),
      );
    }

    if (capabilities.resources?.listChanged) {
      backend.setNotificationHandler(ResourceListChangedNotificationSchema, () =>
        fanOut((proxyServer) => proxyServer.sendResourceListChanged()),
      );
    }

    bus = { servers };
    listChangedBuses.set(backend, bus);
  }

  bus.servers.add(server);

  const prevOnClose = server.onclose;
  let active = true;

  server.onclose = () => {
    if (!active) return;
    active = false;
    bus.servers.delete(server);
    if (!bus.servers.size) listChangedBuses.delete(backend);
    prevOnClose?.();
  };
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
  const capabilities = createProxyCapabilities(backend);
  const toolPipeline = pipe(options.toolMiddleware ?? []);
  const resourcePipeline = pipe(options.resourceMiddleware ?? []);

  const hiddenToolSet = new Set(options.hiddenTools ?? []);
  const passThroughToolSet = new Set(options.passThroughTools ?? []);
  const hiddenResourceSet = new Set(options.hiddenResources ?? []);
  const passThroughResourceSet = new Set(options.passThroughResources ?? []);

  const server = new Server(
    { name: 'mcpose', version: '1.1.1' },
    { capabilities },
  );

  registerListChangedForwarders(backend, server, capabilities);

  // ── Tool handlers ──────────────────────────────────────────────────────────

  if (capabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
      const result = await backend.listTools(req.params, createRequestOptions(extra));
      if (!hiddenToolSet.size) return result;
      return { ...result, tools: result.tools.filter((t) => !hiddenToolSet.has(t.name)) };
    });

    server.setRequestHandler(CallToolRequestSchema, (req, extra) => {
      const name = req.params.name;
      const requestOptions = createRequestOptions(extra);

      if (hiddenToolSet.has(name)) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
      }
      if (passThroughToolSet.has(name)) {
        return backend.callTool(req.params, undefined, requestOptions);
      }
      return toolPipeline(req, (r) => backend.callTool(r.params, undefined, requestOptions));
    });
  }

  // ── Resource handlers ──────────────────────────────────────────────────────

  if (capabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (req, extra) => {
      const result = await backend.listResources(req.params, createRequestOptions(extra));
      if (!hiddenResourceSet.size) return result;
      return { ...result, resources: result.resources.filter((r) => !hiddenResourceSet.has(r.uri)) };
    });

    server.setRequestHandler(ReadResourceRequestSchema, (req, extra) => {
      const uri = req.params.uri;
      const requestOptions = createRequestOptions(extra);

      if (hiddenResourceSet.has(uri)) {
        throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${uri}`);
      }
      if (passThroughResourceSet.has(uri)) {
        return backend.readResource(req.params, requestOptions);
      }
      return resourcePipeline(req, (r) => backend.readResource(r.params, requestOptions));
    });
  }

  // ── Prompt handlers (pass-through) ────────────────────────────────────────

  if (capabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, (req, extra) =>
      backend.listPrompts(req.params, createRequestOptions(extra)),
    );

    server.setRequestHandler(GetPromptRequestSchema, (req, extra) =>
      backend.getPrompt(req.params, createRequestOptions(extra)),
    );
  }

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
 * - Sessions never expire.
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

  const rawClose = server.close.bind(server);
  let shuttingDown = false;

  server.close = ((callback?: (err?: Error) => void) => {
    if (shuttingDown) return rawClose(callback as never);
    shuttingDown = true;

    const activeSessions = [...sessions.values()];
    sessions.clear();

    void Promise.allSettled(
      activeSessions.map(({ proxyServer }) => proxyServer.close()),
    ).finally(() => {
      rawClose(callback as never);
    });

    return server;
  }) as typeof server.close;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, ...(host ? [host] : []), () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
