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
import { pipe, isPassThroughObserver, type Middleware } from './middleware.js';
import type { BackendClient } from './backendClient.js';
import { createProxyContext, type ProxyContext } from './proxyContext.js';
import type { Identity } from './identity.js';
import type { TelemetryEvent } from './telemetry.js';
import { createInMemoryEventStore } from './eventStore.js';
import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { rejectionMcpError } from './rejection.js';
import type { RejectionReason } from './rejection.js';
import { VERSION } from './version.js';

/** Name the proxy advertises when `ProxyOptions.name` is omitted. */
const DEFAULT_PROXY_NAME = 'mcpose';

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
  onRequest?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => boolean | Promise<boolean>;
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
   * Called when a session is closed (client DELETE, TTL expiry, or server
   * shutdown). Wire {@link AuditMiddlewareHandle.closeSession} here to flush
   * the ReplayManifest for the session.
   *
   * @example
   * onSessionClosed: (sessionId) => auditHandle.closeSession(sessionId)
   */
  onSessionClosed?: (sessionId: string) => void;
  /**
   * Re-validates an existing session on every routed request. Return `false`
   * (or throw) to reject with 401. Use to bind sessions to their original
   * credential — e.g. re-check the bearer token — so a leaked
   * `mcp-session-id` alone cannot take over a session.
   */
  validateSession?: (
    req: http.IncomingMessage,
    session: { sessionId: string; identity?: Identity },
  ) => boolean | Promise<boolean>;
  /**
   * Hosts allowed in the `Host` header when
   * {@link enableDnsRebindingProtection} is on. Forwarded to the SDK
   * transport.
   */
  allowedHosts?: string[];
  /** Origins allowed in the `Origin` header. Forwarded to the SDK transport. */
  allowedOrigins?: string[];
  /**
   * Enables the SDK transport's DNS-rebinding protection (Host/Origin
   * checks). Recommended for proxies bound to localhost.
   */
  enableDnsRebindingProtection?: boolean;
}

/** Proxy server options. */
export interface ProxyOptions {
  /**
   * Human-readable name for this proxy instance.
   * Defaults to `'mcpose'` when omitted, so leaving out `options` entirely stays
   * backward compatible.
   */
  name?: string;

  /**
   * Version of this proxy server (yours, not the mcpose library). MCP clients see
   * it in the `initialize` response. Defaults to the mcpose library version when
   * omitted; set it to your own release version when you ship your proxy.
   */
  version?: string;

  /**
   * Tool middleware in response-processing order (first = innermost).
   * @example [piiMW, auditMW]  // pii redacts first, audit logs clean data
   */
  toolMiddleware?: ReadonlyArray<ToolMiddleware>;

  /** Resource middleware in response-processing order (first = innermost). */
  resourceMiddleware?: ReadonlyArray<ResourceMiddleware>;

  /** Tool-list middleware in response-processing order (first = innermost). */
  listToolsMiddleware?: ReadonlyArray<ListToolsMiddleware>;

  /**
   * Tools that skip transforming middleware — upstream response forwarded
   * as-is. Middleware wrapped in `markPassThroughObserver()` (e.g. audit)
   * still runs for these tools.
   */
  passThroughTools?: ReadonlyArray<string>;

  /** Resources that skip middleware — upstream response forwarded as-is. */
  passThroughResources?: ReadonlyArray<string>;

  /**
   * Tools hidden from list_tools and rejected at runtime with
   * MethodNotFound. Precedence: a tool listed here AND in
   * `passThroughTools` stays hidden. Hidden filtering is applied both
   * before and after `listToolsMiddleware`, so list middleware cannot
   * re-expose a hidden tool.
   */
  hiddenTools?: ReadonlyArray<string>;

  /** Resources hidden from list_resources and rejected at runtime with InvalidRequest. */
  hiddenResources?: ReadonlyArray<string>;

  /**
   * Called after every tool call with timing and outcome data. Wire to any
   * custom telemetry sink (an OpenTelemetry adapter is planned for v3).
   * A throwing sink is logged and never fails the tool call.
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
      ? {
          resources: upstream.resources.listChanged
            ? { listChanged: true }
            : {},
        }
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
  // `0` and `''` are legitimate progress tokens — only undefined disables.
  const onprogress =
    progressToken !== undefined && extra.sendNotification
      ? ({
          progress,
          total,
          message,
        }: {
          progress: number;
          total?: number;
          message?: string;
        }) => {
          // A client that disconnected mid-call makes sendNotification
          // reject; dropping the progress tick is the correct outcome.
          void extra
            .sendNotification?.({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress,
                ...(total === undefined ? {} : { total }),
                ...(message === undefined ? {} : { message }),
              },
            })
            .catch(() => {});
        }
      : undefined;

  if (!extra.signal && !onprogress) return undefined;

  return {
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(onprogress ? { onprogress } : {}),
  };
}

/**
 * Credential-bearing headers are stripped before headers reach
 * `ProxyContext` (and through it, audit logs). Identity resolution reads
 * the raw `http.IncomingMessage`, so `resolveIdentity` still sees them.
 */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
]);

function normalizeHeaders(
  headers: http.IncomingHttpHeaders,
): Readonly<Record<string, string>> | undefined {
  const normalized = Object.entries(headers).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (SENSITIVE_HEADERS.has(key)) return acc;
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

function getRejectionReason(err: unknown): RejectionReason | undefined {
  const data = (err as { data?: { rejectionReason?: unknown } } | null)?.data;
  return typeof data?.rejectionReason === 'string'
    ? (data.rejectionReason as RejectionReason)
    : undefined;
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
      await Promise.allSettled(
        [...servers].map((proxyServer) => notify(proxyServer)),
      );
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
      backend.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        () => fanOut((proxyServer) => proxyServer.sendResourceListChanged()),
      );
    }

    bus = { servers };
    listChangedBuses.set(backend, bus);
  }

  bus.servers.add(server);

  let active = true;
  const removeFromBus = () => {
    if (!active) return;
    active = false;
    bus.servers.delete(server);
    if (!bus.servers.size) listChangedBuses.delete(backend);
  };

  // Accessor instead of plain assignment: a consumer setting `server.onclose`
  // after createProxyServer() must not clobber the bus cleanup (which would
  // leak this server into the fan-out set forever).
  let consumerOnClose: (() => void) | undefined;
  Object.defineProperty(server, 'onclose', {
    configurable: true,
    get: () => () => {
      removeFromBus();
      consumerOnClose?.();
    },
    set: (fn: (() => void) | undefined) => {
      consumerOnClose = fn;
    },
  });
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
  if (backend.getServerCapabilities() === undefined) {
    throw new Error(
      'mcpose: backend is not connected (getServerCapabilities() returned undefined). Connect the backend before calling createProxyServer().',
    );
  }

  const capabilities = createProxyCapabilities(backend);
  const toolPipeline = pipe(options.toolMiddleware ?? []);
  // Pass-through tools skip transforming middleware but are still seen by
  // observers (audit, telemetry) marked via markPassThroughObserver().
  const passThroughToolPipeline = pipe(
    (options.toolMiddleware ?? []).filter(isPassThroughObserver),
  );
  const resourcePipeline = pipe(options.resourceMiddleware ?? []);
  const listToolsPipeline = pipe(options.listToolsMiddleware ?? []);

  const hiddenToolSet = new Set(options.hiddenTools ?? []);
  const passThroughToolSet = new Set(options.passThroughTools ?? []);
  const hiddenResourceSet = new Set(options.hiddenResources ?? []);
  const passThroughResourceSet = new Set(options.passThroughResources ?? []);

  const server = new Server(
    {
      name: options.name ?? DEFAULT_PROXY_NAME,
      version: options.version ?? VERSION,
    },
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
      const start = performance.now();

      const emitTelemetry = (
        outcome: TelemetryEvent['outcome'],
        rejectionReason?: RejectionReason,
      ) => {
        try {
          options.onTelemetry?.({
            type: 'tool_call',
            requestId: context.requestId,
            ...(context.sessionId === undefined
              ? {}
              : { sessionId: context.sessionId }),
            tool: name,
            duration_ms: Math.round(performance.now() - start),
            outcome,
            ...(rejectionReason === undefined ? {} : { rejectionReason }),
            ...(context.identity === undefined
              ? {}
              : { identity: context.identity }),
          });
        } catch (err) {
          // A throwing telemetry sink must never fail the tool call.
          console.error(err);
        }
      };

      // Hidden beats pass-through. The rejection is thrown by the innermost
      // `next` INSIDE the pipeline so middleware (audit) observes it in-chain;
      // the backend is never called for hidden tools.
      const isHidden = hiddenToolSet.has(name);
      const pipeline =
        !isHidden && passThroughToolSet.has(name)
          ? passThroughToolPipeline
          : toolPipeline;
      const callBackend = isHidden
        ? async (): Promise<CompatibilityCallToolResult> => {
            throw rejectionMcpError(
              'TOOL_HIDDEN',
              ErrorCode.MethodNotFound,
              `Tool not found: ${name}`,
            );
          }
        : (r: CallToolRequest) =>
            backend.callTool(r.params, undefined, requestOptions);

      try {
        const result = await pipeline(req, callBackend, context);
        // MCP signals tool-level failures in-band via isError, not by throwing.
        emitTelemetry(
          hasToolContent(result) && result.isError === true
            ? 'error'
            : 'success',
        );
        return result;
      } catch (err) {
        const reason = getRejectionReason(err);
        if (reason === undefined) emitTelemetry('error');
        else emitTelemetry('rejected', reason);
        throw err;
      }
    });
  }

  // ── Resource handlers ──────────────────────────────────────────────────────

  if (capabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (req, extra) => {
      const result = await backend.listResources(
        req.params,
        createRequestOptions(extra),
      );
      if (!hiddenResourceSet.size) return result;
      return {
        ...result,
        resources: result.resources.filter(
          (r) => !hiddenResourceSet.has(r.uri),
        ),
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, (req, extra) => {
      const uri = req.params.uri;
      const requestOptions = createRequestOptions(extra);
      const context = getMiddlewareContext(extra.signal);

      if (hiddenResourceSet.has(uri)) {
        throw rejectionMcpError(
          'RESOURCE_HIDDEN',
          ErrorCode.InvalidRequest,
          `Resource not found: ${uri}`,
        );
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

/**
 * Enforces `maxBodyBytes`.
 *
 * Fast path: a declared `Content-Length` over the limit is rejected before
 * any body is read. Chunked/streamed bodies are counted as they arrive.
 *
 * @returns `true` when the request was already rejected (caller must stop).
 */
function applyBodySizeLimit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBodyBytes: number,
): boolean {
  const reject413 = (): void => {
    if (!res.headersSent) {
      res.writeHead(413, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: {
            message: 'Request body too large',
            data: { rejectionReason: 'BODY_LIMIT' },
          },
        }),
      );
    }
  };

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    reject413();
    req.destroy();
    return true;
  }

  let total = 0;
  const originalPush = req.push.bind(req);
  (req as unknown as { push: typeof req.push }).push = (
    chunk: Buffer | string | null,
    enc?: BufferEncoding,
  ): boolean => {
    const chunkBytes =
      chunk === null
        ? 0
        : typeof chunk === 'string'
          ? Buffer.byteLength(chunk, enc)
          : chunk.length;
    if (chunk !== null && total + chunkBytes > maxBodyBytes) {
      reject413();
      if (res.headersSent) {
        // Too late for a clean 413 — sever the connection instead of
        // leaving the client on a hung socket.
        res.destroy();
      } else {
        // Mute the response for downstream writers (the SDK transport will
        // observe the destroyed request and try to send its own error).
        const muted = res as unknown as Record<string, unknown>;
        muted.writeHead = () => res;
        muted.write = () => true;
        muted.end = () => res;
      }
      req.destroy(new Error('Request body too large'));
      return false;
    }
    total += chunkBytes;
    return originalPush(chunk, enc);
  };
  return false;
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
  const mcpPath = httpOptions.path ?? '/mcp';
  const port = httpOptions.port ?? 3000;
  const host = httpOptions.host;
  const eventStore =
    httpOptions.eventStore === null
      ? undefined
      : (httpOptions.eventStore ?? createInMemoryEventStore());

  // session ID → { transport, proxyServer, identity, ttlTimer }
  const sessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      proxyServer: Server;
      identity?: Identity;
      ttlTimer?: NodeJS.Timeout;
    }
  >();

  // Sessions being initialized (identity resolution in flight) — counted so
  // concurrent initializes cannot overshoot maxSessions.
  let pendingSessions = 0;

  const reportError = (err: unknown): void => {
    (httpOptions.onError ?? console.error)(err);
  };

  /**
   * Single teardown path for every way a session can end: client DELETE,
   * TTL expiry, and server shutdown. Clears the TTL timer, fires
   * `onSessionClosed` (guarded — a throwing hook must not break teardown),
   * and closes the proxy server so it leaves the listChanged fan-out bus.
   * Idempotent: a second call for the same id is a no-op.
   */
  const destroySession = (id: string): Promise<void> => {
    const session = sessions.get(id);
    if (!session) return Promise.resolve();
    sessions.delete(id);
    if (session.ttlTimer !== undefined) clearTimeout(session.ttlTimer);
    try {
      httpOptions.onSessionClosed?.(id);
    } catch (err) {
      reportError(err);
    }
    return session.proxyServer.close().catch(reportError);
  };

  const requestHandler = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
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

      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? '';

      if (
        url.pathname !== mcpPath ||
        !['GET', 'POST', 'DELETE'].includes(method)
      ) {
        res.writeHead(404).end();
        return;
      }

      if (method === 'POST') {
        const rejected = applyBodySizeLimit(
          req,
          res,
          httpOptions.maxBodyBytes ?? 4 * 1024 * 1024,
        );
        if (rejected) return;
      }

      const sessionId = req.headers['mcp-session-id'];
      const headers = normalizeHeaders(req.headers);

      if (typeof sessionId === 'string') {
        // Route to existing session — stamp its resolved identity into context
        const session = sessions.get(sessionId);
        if (!session) {
          res.writeHead(404).end();
          return;
        }
        if (httpOptions.validateSession !== undefined) {
          let valid: boolean;
          try {
            valid = await httpOptions.validateSession(req, {
              sessionId,
              ...(session.identity === undefined
                ? {}
                : { identity: session.identity }),
            });
          } catch {
            valid = false;
          }
          if (!valid) {
            if (!res.headersSent) res.writeHead(401).end();
            return;
          }
        }
        const requestContext: Omit<ProxyContext, 'requestId'> = {
          transport: 'http',
          sessionId,
          ...(headers === undefined ? {} : { headers }),
          ...(session.identity === undefined
            ? {}
            : { identity: session.identity }),
        };
        await httpProxyContext.run(requestContext, () =>
          session.transport.handleRequest(req, res),
        );
      } else {
        // New session — only an initialize POST may create one. A
        // session-less GET/DELETE can never initialize, so reject it
        // before constructing a Server/transport (which would otherwise
        // leak into the listChanged fan-out bus).
        if (method !== 'POST') {
          res.writeHead(400, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Bad Request: no valid session ID provided',
              },
              id: null,
            }),
          );
          return;
        }

        // Count this initialize as pending so concurrent initializes
        // cannot overshoot maxSessions while identity resolution awaits.
        if (
          httpOptions.maxSessions !== undefined &&
          sessions.size + pendingSessions >= httpOptions.maxSessions
        ) {
          res.writeHead(503, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              error: {
                message: 'Session limit reached',
                data: { rejectionReason: 'SESSION_LIMIT' },
              },
            }),
          );
          return;
        }
        pendingSessions += 1;

        try {
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
            ...(httpOptions.allowedHosts
              ? { allowedHosts: httpOptions.allowedHosts }
              : {}),
            ...(httpOptions.allowedOrigins
              ? { allowedOrigins: httpOptions.allowedOrigins }
              : {}),
            ...(httpOptions.enableDnsRebindingProtection === undefined
              ? {}
              : {
                  enableDnsRebindingProtection:
                    httpOptions.enableDnsRebindingProtection,
                }),
            onsessioninitialized: (id) => {
              let ttlTimer: NodeJS.Timeout | undefined;
              if (httpOptions.sessionTtlMs !== undefined) {
                ttlTimer = setTimeout(() => {
                  void destroySession(id);
                }, httpOptions.sessionTtlMs);
                ttlTimer.unref();
              }
              sessions.set(id, {
                transport,
                proxyServer,
                identity,
                ...(ttlTimer === undefined ? {} : { ttlTimer }),
              });
            },
            onsessionclosed: (id) => {
              void destroySession(id);
            },
          });

          const requestContext: Omit<ProxyContext, 'requestId'> = {
            transport: 'http',
            ...(headers === undefined ? {} : { headers }),
            ...(identity === undefined ? {} : { identity }),
          };
          await proxyServer.connect(transport);
          try {
            await httpProxyContext.run(requestContext, () =>
              transport.handleRequest(req, res),
            );
          } finally {
            // Non-initialize body: the transport rejected the request and
            // no session was created — close the orphaned proxy server so
            // it does not leak (memory + listChanged fan-out).
            if (transport.sessionId === undefined) {
              void proxyServer.close().catch(reportError);
            }
          }
        } finally {
          pendingSessions -= 1;
        }
      }
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

  server.close = (callback?: (err?: Error) => void) => {
    if (shuttingDown) return rawClose(callback);
    shuttingDown = true;

    // Tear down every session through the single teardown path (clears TTL
    // timers, fires onSessionClosed so audit manifests flush on shutdown).
    void Promise.allSettled(
      [...sessions.keys()].map((id) => destroySession(id)),
    ).finally(() => {
      rawClose(callback);
      // Idle keep-alive and lingering SSE sockets would otherwise keep the
      // close callback pending indefinitely.
      server.closeAllConnections();
    });

    return server;
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, ...(host ? [host] : []), () => {
      server.off('error', reject);
      // Route post-listen server errors (e.g. EMFILE) to onError instead of
      // crashing the process with an unhandled 'error' event.
      server.on('error', reportError);
      resolve(server);
    });
  });
}
