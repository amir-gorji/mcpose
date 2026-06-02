/** MCP proxy core: wires server→upstream through middleware pipelines. */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as http from 'node:http';
import * as https from 'node:https';
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
  type ListToolsRequest,
  type ListToolsResult,
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
import { createProxyContext, type ProxyContext } from './proxyContext.js';
import type { Identity } from './identity.js';
import type { TelemetryEvent } from './telemetry.js';
import { createInMemoryEventStore } from './eventStore.js';
import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { rejectionMcpError } from './rejection.js';
import type { RejectionReason } from './rejection.js';

export type { ProxyContext } from './proxyContext.js';

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

/** Middleware for tool-list responses. */
export type ListToolsMiddleware = Middleware<ListToolsRequest, ListToolsResult>;

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
  /** Called for every incoming request before MCP handling. Return false to block (caller writes its own response). Throw to get a 401. */
  onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean | Promise<boolean>;
  /** Called on unhandled errors instead of console.error. */
  onError?: (err: unknown) => void;
  /** Maximum request body size in bytes. Default: 4 MB. */
  maxBodyBytes?: number;
  /** Maximum number of concurrent MCP sessions. Excess requests return 503. */
  maxSessions?: number;
  /** Session TTL in milliseconds. Sessions are closed after this duration. */
  sessionTtlMs?: number;
  /**
   * Resolves caller identity from the initial session request.
   * Called once per new session; the result is stamped on every
   * {@link ProxyContext} within that session.
   *
   * Supply a JWT extractor, mTLS cert reader, API-key lookup, or any async
   * function returning an {@link Identity}. Errors thrown here abort the
   * session with a 401.
   *
   * @example
   * resolveIdentity: extractJwtIdentity({ jwksUri: '...' })
   */
  resolveIdentity?: (req: http.IncomingMessage) => Identity | Promise<Identity>;
  /**
   * TLS options for mutual TLS (mTLS). When provided, the proxy listens on
   * HTTPS and requires client certificates signed by the supplied CA.
   *
   * @example
   * tlsOptions: {
   *   key: fs.readFileSync('server.key'),
   *   cert: fs.readFileSync('server.crt'),
   *   ca: fs.readFileSync('trusted-ca.crt'),
   *   requestCert: true,
   *   rejectUnauthorized: true,
   * }
   */
  tlsOptions?: https.ServerOptions;
  /**
   * Event store for SSE reconnect replay. Defaults to an in-memory store
   * (suitable for single-instance deployments). For multi-instance / HA
   * deployments, supply a Redis or Postgres-backed implementation.
   *
   * Set to `null` to disable reconnect replay entirely.
   */
  eventStore?: EventStore | null;
  /**
   * Called when a session is closed (client DELETE or TTL expiry).
   * Wire {@link AuditMiddlewareHandle.closeSession} here to flush the
   * ReplayManifest for the session.
   *
   * @example
   * onSessionClosed: (sessionId) => auditHandle.closeSession(sessionId)
   */
  onSessionClosed?: (sessionId: string) => void;
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

  /** Tool-list middleware in response-processing order (first = innermost). */
  listToolsMiddleware?: ReadonlyArray<ListToolsMiddleware>;

  /** Tools that skip middleware — upstream response forwarded as-is. */
  passThroughTools?: ReadonlyArray<string>;

  /** Resources that skip middleware — upstream response forwarded as-is. */
  passThroughResources?: ReadonlyArray<string>;

  /** Tools hidden from list_tools and rejected at runtime with MethodNotFound. */
  hiddenTools?: ReadonlyArray<string>;

  /** Resources hidden from list_resources and rejected at runtime with InvalidRequest. */
  hiddenResources?: ReadonlyArray<string>;

  /**
   * Called after every tool call with timing and outcome data.
   * Wire to {@link https://www.npmjs.com/package/@mcpose/otel | @mcpose/otel}
   * or any custom telemetry sink.
   */
  onTelemetry?: (event: TelemetryEvent) => void;
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
const httpProxyContext = new AsyncLocalStorage<
  Omit<ProxyContext, 'requestId'>
>();

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

function normalizeHeaders(
  headers: http.IncomingHttpHeaders,
): Readonly<Record<string, string>> | undefined {
  const normalized = Object.entries(headers).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (typeof value === 'string') {
        acc[key] = value;
        return acc;
      }
      if (Array.isArray(value)) {
        acc[key] = value.join(', ');
      }
      return acc;
    },
    {},
  );

  return Object.keys(normalized).length ? normalized : undefined;
}

function getMiddlewareContext(signal?: AbortSignal): ProxyContext {
  return createProxyContext({
    ...httpProxyContext.getStore(),
    ...(signal === undefined ? {} : { signal }),
  });
}

function filterHiddenTools(
  result: ListToolsResult,
  hiddenToolSet: ReadonlySet<string>,
): ListToolsResult {
  if (!hiddenToolSet.size) return result;
  return {
    ...result,
    tools: result.tools.filter((tool) => !hiddenToolSet.has(tool.name)),
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
  const listToolsPipeline = pipe(options.listToolsMiddleware ?? []);

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
      const requestOptions = createRequestOptions(extra);
      const context = getMiddlewareContext(extra.signal);
      const result = await listToolsPipeline(
        req,
        async (currentReq) =>
          filterHiddenTools(
            await backend.listTools(currentReq.params, requestOptions),
            hiddenToolSet,
          ),
        context,
      );

      return filterHiddenTools(result, hiddenToolSet);
    });

    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const name = req.params.name;
      const requestOptions = createRequestOptions(extra);
      const context = getMiddlewareContext(extra.signal);
      const start = Date.now();

      const emitTelemetry = (
        outcome: TelemetryEvent['outcome'],
        rejectionReason?: RejectionReason,
      ) => {
        options.onTelemetry?.({
          type: 'tool_call',
          requestId: context.requestId,
          ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
          tool: name,
          duration_ms: Date.now() - start,
          outcome,
          ...(rejectionReason === undefined ? {} : { rejectionReason }),
          ...(context.identity === undefined ? {} : { identity: context.identity }),
        });
      };

      if (hiddenToolSet.has(name)) {
        emitTelemetry('rejected', 'TOOL_HIDDEN');
        throw rejectionMcpError('TOOL_HIDDEN', ErrorCode.MethodNotFound, `Tool not found: ${name}`);
      }
      if (passThroughToolSet.has(name)) {
        try {
          const result = await backend.callTool(req.params, undefined, requestOptions);
          emitTelemetry('success');
          return result;
        } catch (err) {
          emitTelemetry('error');
          throw err;
        }
      }
      try {
        const result = await toolPipeline(
          req,
          (r) => backend.callTool(r.params, undefined, requestOptions),
          context,
        );
        emitTelemetry('success');
        return result;
      } catch (err) {
        emitTelemetry('error');
        throw err;
      }
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
      const context = getMiddlewareContext(extra.signal);

      if (hiddenResourceSet.has(uri)) {
        throw rejectionMcpError('RESOURCE_HIDDEN', ErrorCode.InvalidRequest, `Resource not found: ${uri}`);
      }
      if (passThroughResourceSet.has(uri)) {
        return backend.readResource(req.params, requestOptions);
      }
      return resourcePipeline(
        req,
        (r) => backend.readResource(r.params, requestOptions),
        context,
      );
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

function applyBodySizeLimit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBodyBytes: number,
): void {
  let total = 0;
  const originalPush = req.push.bind(req);
  (req as unknown as { push: typeof req.push }).push = (
    chunk: Buffer | null,
    enc?: BufferEncoding,
  ): boolean => {
    if (chunk !== null && total + chunk.length > maxBodyBytes) {
      if (!res.headersSent) res.writeHead(413).end();
      // Mute the response for downstream writers (the SDK transport will
      // observe the destroyed request and try to send its own error).
      const muted = res as unknown as Record<string, unknown>;
      muted.writeHead = () => res;
      muted.write = () => true;
      muted.end = () => res;
      req.destroy(new Error('Request body too large'));
      return false;
    }
    if (chunk !== null) total += chunk.length;
    return originalPush(chunk, enc);
  };
}

/**
 * Starts the proxy over Streamable HTTP with stateful sessions.
 *
 * Sessions keyed by `mcp-session-id`. Upstream notifications fanned out to
 * all active sessions via their GET SSE stream. Dropped connections can
 * replay missed notifications via the built-in in-memory EventStore (or a
 * custom persistent store for multi-instance deployments).
 *
 * @returns Promise resolving to the listening `http.Server` (or `https.Server`
 * when `tlsOptions` is supplied).
 */
export function startHttpProxy(
  backend: BackendClient,
  options: ProxyOptions = {},
  httpOptions: HttpProxyOptions = {},
): Promise<http.Server> {
  const mcpPath   = httpOptions.path ?? '/mcp';
  const port      = httpOptions.port ?? 3000;
  const host      = httpOptions.host;
  const eventStore = httpOptions.eventStore === null
    ? undefined
    : (httpOptions.eventStore ?? createInMemoryEventStore());

  // session ID → { transport, proxyServer, identity }
  const sessions = new Map<string, {
    transport: StreamableHTTPServerTransport;
    proxyServer: Server;
    identity?: Identity;
  }>();

  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const handle = async () => {
      if (httpOptions.onRequest !== undefined) {
        let allowed: boolean;
        try {
          allowed = await httpOptions.onRequest(req, res);
        } catch {
          if (!res.headersSent) res.writeHead(401).end();
          return;
        }
        if (!allowed) return;
      }

      const url    = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? '';

      if (url.pathname !== mcpPath || !['GET', 'POST', 'DELETE'].includes(method)) {
        res.writeHead(404).end();
        return;
      }

      if (method === 'POST') {
        applyBodySizeLimit(req, res, httpOptions.maxBodyBytes ?? 4 * 1024 * 1024);
      }

      const sessionId = req.headers['mcp-session-id'];
      const headers = normalizeHeaders(req.headers);

      await httpProxyContext.run(
        // Base context — requestId added per-request by getMiddlewareContext()
        { transport: 'http' } as Omit<ProxyContext, 'requestId'>,
        async () => {
          if (typeof sessionId === 'string') {
            // Route to existing session — stamp its resolved identity into context
            const session = sessions.get(sessionId);
            if (!session) { res.writeHead(404).end(); return; }
            const requestContext: Omit<ProxyContext, 'requestId'> = {
              transport: 'http',
              sessionId,
              ...(headers === undefined ? {} : { headers }),
              ...(session.identity === undefined ? {} : { identity: session.identity }),
            };
            await httpProxyContext.run(requestContext, () =>
              session.transport.handleRequest(req, res),
            );
          } else {
            // New session (initialize request)
            if (httpOptions.maxSessions !== undefined && sessions.size >= httpOptions.maxSessions) {
              res.writeHead(503).end();
              return;
            }

            // Resolve identity once for the lifetime of this session
            let identity: Identity | undefined;
            if (httpOptions.resolveIdentity !== undefined) {
              try {
                identity = await httpOptions.resolveIdentity(req);
              } catch {
                if (!res.headersSent) res.writeHead(401).end();
                return;
              }
            }

            const proxyServer = createProxyServer(backend, options);
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: randomUUID,
              ...(eventStore ? { eventStore } : {}),
              onsessioninitialized: (id) => {
                sessions.set(id, { transport, proxyServer, identity });
                if (httpOptions.sessionTtlMs !== undefined) {
                  const timer = setTimeout(() => {
                    const session = sessions.get(id);
                    if (session) {
                      sessions.delete(id);
                      void session.proxyServer.close();
                    }
                  }, httpOptions.sessionTtlMs);
                  timer.unref();
                }
              },
              onsessionclosed: (id) => {
                sessions.delete(id);
                httpOptions.onSessionClosed?.(id);
              },
            });

            const requestContext: Omit<ProxyContext, 'requestId'> = {
              transport: 'http',
              ...(headers === undefined ? {} : { headers }),
              ...(identity === undefined ? {} : { identity }),
            };
            await proxyServer.connect(transport);
            await httpProxyContext.run(requestContext, () =>
              transport.handleRequest(req, res),
            );
          }
        },
      );
    };

    handle().catch((err) => {
      if (!res.headersSent) res.writeHead(500).end();
      (httpOptions.onError ?? console.error)(err);
    });
  };

  const server: http.Server = httpOptions.tlsOptions
    ? https.createServer(httpOptions.tlsOptions, requestHandler)
    : http.createServer(requestHandler);

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
