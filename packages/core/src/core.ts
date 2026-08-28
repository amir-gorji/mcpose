/** MCP proxy core: wires server→upstream through middleware pipelines. */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as http from 'node:http';
import * as https from 'node:https';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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
  type CallToolRequestParams,
  type CallToolResult,
  type CompatibilityCallToolResult,
  type ContentBlock,
  type TextContent,
  type ReadResourceRequest,
  type ReadResourceResult,
  type ServerCapabilities,
  type Tool,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { pipe, isPassThroughObserver, type Middleware } from './middleware.js';
import type { HiddenToolPredicate } from './hiddenTools.js';
import type { BackendClient } from './backendClient.js';
import {
  createProxyContext,
  type ProxyContext,
  type ProxyIdentity,
} from './proxyContext.js';
import type { Identity } from './identity.js';
import type {
  BackendDegradedTelemetryEvent,
  TelemetryEvent,
  ToolCallTelemetryEvent,
} from './telemetry.js';
import {
  listAcrossMesh,
  normalizeBackends,
  routeNamespaced,
  type Backends,
  type MeshEntry,
} from './mesh.js';
import { createInMemoryEventStore } from './eventStore.js';
import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { rejectionMcpError } from './rejection.js';
import type { RejectionReason } from './rejection.js';
import { VERSION } from './version.js';

/** Name the proxy advertises when `ProxyOptions.name` is omitted. */
const DEFAULT_PROXY_NAME = 'mcpose';

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
 * The result channels of a `CallToolResult` — everything a redaction or
 * transform middleware must account for:
 *
 * 1. `content` blocks (text, image, audio, resource link, embedded
 *    resource), each carrying its own block-level `_meta`,
 * 2. `structuredContent`, the machine-readable mirror of the content,
 * 3. result-level `_meta`,
 * 4. `isError`,
 * 5. unknown extra keys via the index signature.
 *
 * Redaction that maps only `.content` misses 2, 3, and the non-text
 * members of 1. Use {@link mapToolResult} to cover every payload channel
 * by construction; channel 3 is stripped at the proxy boundary by default
 * via `ProxyOptions.stripResultMeta` (ADR-0009).
 *
 * This guard narrows `CompatibilityCallToolResult` to `CallToolResult`
 * (has `.content` array). Both union members carry `[x: string]: unknown`,
 * so this avoids unsafe casts.
 */
export function hasToolContent(
  r: CompatibilityCallToolResult,
): r is CallToolResult {
  return Array.isArray(r.content);
}

/**
 * Handlers for {@link mapToolResult}, one per payload channel. All three
 * are required, so forgetting a channel is a compile error rather than a
 * silent leak.
 */
export interface ToolResultHandlers {
  /** Maps a text content block. Return `null` to drop the block. */
  onText: (block: TextContent) => ContentBlock | null;
  /**
   * Maps a non-text content block (image, audio, resource link, embedded
   * resource). Return `null` to drop the block.
   */
  onOther: (block: Exclude<ContentBlock, TextContent>) => ContentBlock | null;
  /**
   * Maps `structuredContent`. Called only when the field is present.
   * Return `undefined` to remove the field entirely.
   */
  onStructured: (
    structured: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
}

/**
 * Maps every payload channel of a tool result through the given handlers.
 *
 * The legacy `{ toolResult }` shape (protocol 2024-10-07) is returned
 * untouched. `isError`, result-level `_meta`, and unknown extra keys are
 * preserved by spread — result-level `_meta` needs no handler because the
 * proxy strips it by default (`stripResultMeta`, ADR-0009); with
 * `stripResultMeta: false` forwarding it is the consumer's explicit choice.
 */
export function mapToolResult(
  result: CompatibilityCallToolResult,
  handlers: ToolResultHandlers,
): CompatibilityCallToolResult {
  if (!hasToolContent(result)) return result;
  const content = result.content
    .map((block) =>
      block.type === 'text' ? handlers.onText(block) : handlers.onOther(block),
    )
    .filter((block): block is ContentBlock => block !== null);
  const structured =
    result.structuredContent === undefined
      ? undefined
      : handlers.onStructured(result.structuredContent);
  const { structuredContent: _dropped, ...rest } = result;
  return {
    ...rest,
    content,
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

/** HTTP transport options for {@link startHttpProxy}. */
export interface HttpProxyOptions {
  /** Default: 3000 */
  port?: number;
  /**
   * Bind address. Default: `'127.0.0.1'` (loopback).
   *
   * Binding a non-loopback address (e.g. `'0.0.0.0'`) exposes an
   * unauthenticated MCP proxy holding an authenticated upstream session to
   * the network, so it is a deliberate opt-in; doing so without
   * {@link resolveIdentity} reports a startup warning through {@link onError}.
   */
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
   * transport, which only validates against a non-empty list.
   *
   * Default: for a loopback bind, derived from the effective bind address
   * and the real listening port (`127.0.0.1:<port>`, `localhost:<port>`,
   * `[::1]:<port>`). An explicit value is used verbatim, never merged with
   * the derived list. No list is derived for a non-loopback bind.
   */
  allowedHosts?: string[];
  /**
   * Origins allowed in the `Origin` header. Forwarded to the SDK transport,
   * which only validates against a non-empty list.
   *
   * Default: for a loopback bind, the derived {@link allowedHosts} entries
   * as origins (`http://` or `https://` matching {@link tlsOptions}). An
   * explicit value is used verbatim, never merged.
   */
  allowedOrigins?: string[];
  /**
   * Enables the SDK transport's DNS-rebinding protection (Host/Origin
   * checks). Default: `true` when the effective bind address is loopback,
   * `false` otherwise (a non-loopback bind usually sits behind a gateway
   * that rewrites `Host`).
   *
   * Enabling this on a non-loopback bind without explicit
   * {@link allowedHosts} / {@link allowedOrigins} validates nothing and
   * reports a startup warning through {@link onError}.
   */
  enableDnsRebindingProtection?: boolean;
}

/**
 * A tool the proxy implements itself, instead of forwarding to the
 * upstream. See ADR-0007.
 */
export interface LocalTool {
  /** The tool definition advertised in `tools/list`. */
  tool: Tool;
  /**
   * Runs instead of the upstream call, from inside the innermost `next`,
   * so the whole `toolMiddleware` pipeline (audit, redaction) still
   * applies.
   */
  handler: (
    params: CallToolRequestParams,
    context: ProxyContext,
  ) => Promise<CallToolResult>;
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
   *
   * A name array cannot see through a dispatcher (meta-tool) that takes
   * the real tool name as an argument. Pass a {@link HiddenToolPredicate}
   * (e.g. {@link dispatcherAwareBlock}) to close that bypass: it receives
   * `undefined` args during list filtering and always an object at call
   * time. See ADR-0006.
   */
  hiddenTools?: ReadonlyArray<string> | HiddenToolPredicate;

  /** Resources hidden from list_resources and rejected at runtime with InvalidRequest. */
  hiddenResources?: ReadonlyArray<string>;

  /**
   * Strips `params._meta` from every request the proxy forwards (tool
   * calls, resource reads, list and prompt calls). Default: `true`.
   *
   * MCP clients put correlation identifiers there (VS Code sends
   * `progressToken`, a W3C `traceparent`, and `vscode/conversationId`),
   * and the upstream is frequently a third party. The strip happens at the
   * proxy boundary, before the pipeline, so middleware sees the stripped
   * request and can still add its own `_meta` deliberately. Progress relay
   * is unaffected: the proxy reads the client's progress token from the
   * server-side request `extra`, and the SDK client stamps its own token
   * on the upstream request.
   *
   * Applies to `passThroughTools` too; disable only globally with `false`
   * for upstreams that read other `_meta` keys. See ADR-0008.
   */
  stripRequestMeta?: boolean;

  /**
   * Strips top-level `_meta` from every result the proxy returns from the
   * upstream (tool calls, resource reads, list and prompt calls).
   * Default: `true`.
   *
   * The response-direction mirror of {@link stripRequestMeta}: upstreams
   * stamp correlation identifiers there (the SDK stamps
   * `io.modelcontextprotocol/related-task`), and the client is a third
   * party to them. The strip happens at the upstream boundary, inside the
   * innermost `next`, so middleware sees the stripped result and any
   * `_meta` middleware adds deliberately still reaches the client.
   *
   * Local tool results are not stripped (they have no upstream), and
   * nested `_meta` (per-tool in `tools[]`, per-block in `content`) is
   * untouched. Applies to pass-through tools and resources too; disable
   * only globally with `false`. See ADR-0009.
   */
  stripResultMeta?: boolean;

  /**
   * Tools the proxy implements itself. Local tools appear in `tools/list`
   * (first page only, so pagination does not duplicate them) and route to
   * their handler instead of the upstream, from inside the innermost
   * `next`, so the full `toolMiddleware` pipeline still runs.
   *
   * Precedence: `hiddenTools` beats a local tool; a local tool beats (and
   * shadows) an upstream tool of the same name; `passThroughTools` has no
   * effect on a local tool, because pass-through means "forward the
   * upstream response as-is" and a local tool has no upstream.
   *
   * The proxy advertises the `tools` capability when this is non-empty
   * even if the upstream has none. A duplicate local tool name throws at
   * {@link createProxyServer}. See ADR-0007.
   */
  localTools?: ReadonlyArray<LocalTool>;

  /**
   * Called after every tool call with timing and outcome data. Wire to any
   * custom telemetry sink (an OpenTelemetry adapter is planned for v3).
   * A throwing sink is logged and never fails the tool call.
   */
  onTelemetry?: (event: TelemetryEvent) => void;
}

type ProgressToken = string | number;
type BackendRequestOptions = Parameters<BackendClient['listTools']>[1];
// Structural mirror of the SDK's `RequestHandlerExtra`. The SDK declares its
// optional members as `?: T | undefined`, so this type has to as well to stay
// assignable under `exactOptionalPropertyTypes`.
type ProxyRequestExtra = {
  signal?: AbortSignal | undefined;
  _meta?: { progressToken?: ProgressToken | undefined } | undefined;
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

/**
 * Union of every backend's capabilities, plus the ADR-0007 rule that a
 * non-empty `localTools` advertises `tools` on its own.
 *
 * Mesh mode advertises no `resources`: a resource is addressed by URI, and a
 * URI cannot be namespaced without rewriting an identifier every party
 * treats as opaque (ADR-0013, deferred to #100).
 */
function createProxyCapabilities(
  entries: ReadonlyArray<MeshEntry>,
  hasLocalTools: boolean,
  mesh: boolean,
): ServerCapabilities {
  const upstreams = entries.map((entry) =>
    entry.client.getServerCapabilities(),
  );
  const listChanged = (supported: boolean) =>
    supported ? { listChanged: true } : {};

  return {
    ...(upstreams.some((u) => u?.tools) || hasLocalTools
      ? { tools: listChanged(upstreams.some((u) => u?.tools?.listChanged)) }
      : {}),
    ...(!mesh && upstreams.some((u) => u?.resources)
      ? {
          resources: listChanged(
            upstreams.some((u) => u?.resources?.listChanged),
          ),
        }
      : {}),
    ...(upstreams.some((u) => u?.prompts)
      ? { prompts: listChanged(upstreams.some((u) => u?.prompts?.listChanged)) }
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
          total?: number | undefined;
          message?: string | undefined;
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

function getMiddlewareContext(
  proxy: ProxyIdentity,
  signal?: AbortSignal,
): ProxyContext {
  return createProxyContext({
    ...httpProxyContext.getStore(),
    ...(signal === undefined ? {} : { signal }),
    proxy,
  });
}

function getRejectionReason(err: unknown): RejectionReason | undefined {
  const data = (err as { data?: { rejectionReason?: unknown } } | null)?.data;
  return typeof data?.rejectionReason === 'string'
    ? (data.rejectionReason as RejectionReason)
    : undefined;
}

/**
 * Removes `params._meta` at the proxy boundary, before the pipeline runs,
 * so middleware sees the stripped request, can still add its own `_meta`
 * deliberately, and audit hashes cover what is actually forwarded.
 * Identity function when there is nothing to strip.
 */
function stripParamsMeta<
  Req extends { params?: { _meta?: unknown } | undefined },
>(req: Req): Req {
  if (req.params === undefined || !('_meta' in req.params)) return req;
  const { _meta: _stripped, ...params } = req.params;
  return { ...req, params };
}

/**
 * Removes top-level `_meta` from an upstream result at the proxy boundary,
 * inside the innermost `next`, so middleware sees the stripped result and
 * middleware-added `_meta` still reaches the client. Nested `_meta`
 * (per-tool in `tools[]`, per-block in `content`) is untouched.
 * Identity function when there is nothing to strip.
 */
function stripTopLevelMeta<Res extends { _meta?: unknown }>(res: Res): Res {
  if (!('_meta' in res)) return res;
  const { _meta: _stripped, ...rest } = res;
  // Omit<Res, '_meta'> still satisfies Res: `_meta` is optional.
  return rest as Res;
}

/**
 * Validates and indexes `localTools`. Throws on a duplicate name: there is
 * no correct way to pick one, and silently keeping the last would route
 * calls to a handler the configuration does not obviously name.
 */
function buildLocalToolMap(
  localTools: ReadonlyArray<LocalTool> | undefined,
): Map<string, LocalTool> {
  const localToolMap = new Map<string, LocalTool>();
  for (const localTool of localTools ?? []) {
    const toolName = localTool.tool.name;
    if (localToolMap.has(toolName)) {
      throw new Error(`mcpose: duplicate local tool name "${toolName}"`);
    }
    localToolMap.set(toolName, localTool);
  }
  return localToolMap;
}

/** Normalizes the `hiddenTools` option to its predicate form. */
function toHiddenToolPredicate(
  hiddenTools: ReadonlyArray<string> | HiddenToolPredicate | undefined,
): HiddenToolPredicate {
  if (typeof hiddenTools === 'function') return hiddenTools;
  const hiddenToolSet = new Set(hiddenTools ?? []);
  return (name) => hiddenToolSet.has(name);
}

function filterHiddenTools(
  result: ListToolsResult,
  isHiddenTool: HiddenToolPredicate,
): ListToolsResult {
  // List phase: a listed tool has no arguments, so args is undefined.
  const tools = result.tools.filter(
    (tool) => !isHiddenTool(tool.name, undefined),
  );
  return tools.length === result.tools.length ? result : { ...result, tools };
}

/**
 * Subscribes `server` to every backend's list-changed notifications, so a
 * mesh fans them in through the same per-backend bus a 1:1 proxy uses.
 *
 * A surface is forwarded only when both the backend and the proxy advertise
 * it: in mesh mode the proxy has no `resources` capability, and the SDK
 * would reject a notification for a surface the server never advertised.
 */
function registerListChangedForwarders(
  entries: ReadonlyArray<MeshEntry>,
  server: Server,
  capabilities: ServerCapabilities,
): void {
  const leaveBuses: Array<() => void> = [];

  for (const { client } of entries) {
    const upstream = client.getServerCapabilities() ?? {};
    const forwards = {
      tools:
        capabilities.tools?.listChanged === true &&
        upstream.tools?.listChanged === true,
      prompts:
        capabilities.prompts?.listChanged === true &&
        upstream.prompts?.listChanged === true,
      resources:
        capabilities.resources?.listChanged === true &&
        upstream.resources?.listChanged === true,
    };
    if (!forwards.tools && !forwards.prompts && !forwards.resources) continue;

    let bus = listChangedBuses.get(client);

    if (!bus) {
      const servers = new Set<Server>();
      const fanOut = async (
        notify: (proxyServer: Server) => Promise<void>,
      ): Promise<void> => {
        await Promise.allSettled(
          [...servers].map((proxyServer) => notify(proxyServer)),
        );
      };

      if (forwards.tools) {
        client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
          fanOut((proxyServer) => proxyServer.sendToolListChanged()),
        );
      }

      if (forwards.prompts) {
        client.setNotificationHandler(PromptListChangedNotificationSchema, () =>
          fanOut((proxyServer) => proxyServer.sendPromptListChanged()),
        );
      }

      if (forwards.resources) {
        client.setNotificationHandler(
          ResourceListChangedNotificationSchema,
          () => fanOut((proxyServer) => proxyServer.sendResourceListChanged()),
        );
      }

      bus = { servers };
      listChangedBuses.set(client, bus);
    }

    const joined = bus;
    joined.servers.add(server);

    let active = true;
    leaveBuses.push(() => {
      if (!active) return;
      active = false;
      joined.servers.delete(server);
      if (!joined.servers.size) listChangedBuses.delete(client);
    });
  }

  if (leaveBuses.length === 0) return;

  // Accessor instead of plain assignment: a consumer setting `server.onclose`
  // after createProxyServer() must not clobber the bus cleanup (which would
  // leak this server into the fan-out set forever).
  let consumerOnClose: (() => void) | undefined;
  Object.defineProperty(server, 'onclose', {
    configurable: true,
    get: () => () => {
      for (const leaveBus of leaveBuses) leaveBus();
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
 * @param backends - Connected (or mock) upstream MCP client for a 1:1 proxy,
 * or a record of named backends for mesh mode (ADR-0013), where every
 * upstream tool and prompt is exposed as `<backendKey>__<name>`.
 * @param options - Middleware stacks, hidden/passthrough sets.
 * @returns Configured {@link Server} ready to connect.
 */
export function createProxyServer(
  backends: Backends,
  options: ProxyOptions = {},
): Server {
  const { mesh, entries } = normalizeBackends(backends);
  for (const { key, client } of entries) {
    if (client.getServerCapabilities() === undefined) {
      throw new Error(
        `mcpose: backend${mesh ? ` "${key}"` : ''} is not connected (getServerCapabilities() returned undefined). Connect the backend before calling createProxyServer().`,
      );
    }
  }
  const backend = entries[0]!.client;

  const localToolMap = buildLocalToolMap(options.localTools);
  // Only backends that advertise a surface are queried or routed to, so an
  // otherwise-valid prefix naming a tools-less backend is unroutable rather
  // than a call the upstream cannot serve.
  const toolBackends = entries.filter(
    (entry) => entry.client.getServerCapabilities()?.tools !== undefined,
  );
  const promptBackends = entries.filter(
    (entry) => entry.client.getServerCapabilities()?.prompts !== undefined,
  );
  const toolBackendsByKey = new Map(
    toolBackends.map((entry) => [entry.key, entry.client] as const),
  );
  const promptBackendsByKey = new Map(
    promptBackends.map((entry) => [entry.key, entry.client] as const),
  );
  const upstreamHasTools = toolBackends.length > 0;

  const capabilities = createProxyCapabilities(
    entries,
    localToolMap.size > 0,
    mesh,
  );
  const toolPipeline = pipe(options.toolMiddleware ?? []);
  // Pass-through tools skip transforming middleware but are still seen by
  // observers (audit, telemetry) marked via markPassThroughObserver().
  const passThroughToolPipeline = pipe(
    (options.toolMiddleware ?? []).filter(isPassThroughObserver),
  );
  const resourcePipeline = pipe(options.resourceMiddleware ?? []);
  const listToolsPipeline = pipe(options.listToolsMiddleware ?? []);

  const isHiddenTool = toHiddenToolPredicate(options.hiddenTools);
  // Applied uniformly at every handler entry, pass-through included: a
  // privacy control a per-tool option could silently switch off would be
  // the same false-confidence failure as the dispatcher bypass (ADR-0006).
  const stripMeta = options.stripRequestMeta !== false;
  const stripRequest = <
    Req extends { params?: { _meta?: unknown } | undefined },
  >(
    req: Req,
  ): Req => (stripMeta ? stripParamsMeta(req) : req);
  // The response-direction mirror: applied to every upstream result at the
  // innermost `next`, never to local tool results (they have no upstream).
  const stripResMeta = options.stripResultMeta !== false;
  const stripResult = <Res extends { _meta?: unknown }>(res: Res): Res =>
    stripResMeta ? stripTopLevelMeta(res) : res;
  const passThroughToolSet = new Set(options.passThroughTools ?? []);
  const hiddenResourceSet = new Set(options.hiddenResources ?? []);
  const passThroughResourceSet = new Set(options.passThroughResources ?? []);

  // Stamped onto every ProxyContext so middleware and the audit trail can
  // attribute events to this proxy instance (#85, ADR-0012). Frozen because
  // the one object is aliased into the SDK Server, every context, and every
  // audit event: a middleware mutating it would rewrite provenance already
  // recorded elsewhere.
  const proxyIdentity: ProxyIdentity = Object.freeze({
    name: options.name ?? DEFAULT_PROXY_NAME,
    version: options.version ?? VERSION,
  });

  const server = new Server(proxyIdentity, { capabilities });

  registerListChangedForwarders(entries, server, capabilities);

  /**
   * Reports a backend that dropped out of a mesh list. Failure isolation is
   * only safe if the gap is visible, and a throwing sink must not turn a
   * degraded list into a failed one.
   */
  const reportDegraded = (
    context: ProxyContext,
    backendKey: string,
    method: BackendDegradedTelemetryEvent['method'],
    error: unknown,
  ): void => {
    try {
      options.onTelemetry?.({
        type: 'backend_degraded',
        requestId: context.requestId,
        ...(context.sessionId === undefined
          ? {}
          : { sessionId: context.sessionId }),
        backend: backendKey,
        method,
        error,
        ...(context.identity === undefined
          ? {}
          : { identity: context.identity }),
      });
    } catch (err) {
      console.error(err);
    }
  };

  // ── Tool handlers ──────────────────────────────────────────────────────────

  if (capabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (rawReq, extra) => {
      const req = stripRequest(rawReq);
      const requestOptions = createRequestOptions(extra);
      const context = getMiddlewareContext(proxyIdentity, extra.signal);
      // Local tools are overlaid inside the innermost `next`, so
      // listToolsMiddleware sees them exactly as it sees upstream tools.
      // They are added to the first page only (no cursor), so a paginating
      // client sees each local tool once; the shadow filter runs on every
      // page, so the client sees exactly one entry per name.
      const result = await listToolsPipeline(
        req,
        async (currentReq) => {
          const upstreamResult: ListToolsResult = mesh
            ? {
                // A mesh has no cursor that means "page 3 of the union", so
                // every backend is drained into one complete page.
                tools: await listAcrossMesh(
                  toolBackends,
                  async (client, cursor) => {
                    const page = stripResult(
                      await client.listTools(
                        cursor === undefined ? {} : { cursor },
                        requestOptions,
                      ),
                    );
                    return { items: page.tools, nextCursor: page.nextCursor };
                  },
                  (key, error) =>
                    reportDegraded(context, key, 'tools/list', error),
                ),
              }
            : upstreamHasTools
              ? stripResult(
                  await backend.listTools(currentReq.params, requestOptions),
                )
              : { tools: [] };
          if (!localToolMap.size) {
            return filterHiddenTools(upstreamResult, isHiddenTool);
          }
          const tools = [
            ...upstreamResult.tools.filter((t) => !localToolMap.has(t.name)),
            // A mesh response is always the only page, so local tools belong
            // on it whatever cursor the client sent.
            ...(mesh || currentReq.params?.cursor === undefined
              ? [...localToolMap.values()].map((lt) => lt.tool)
              : []),
          ];
          return filterHiddenTools({ ...upstreamResult, tools }, isHiddenTool);
        },
        context,
      );

      return filterHiddenTools(result, isHiddenTool);
    });

    server.setRequestHandler(CallToolRequestSchema, async (rawReq, extra) => {
      const req = stripRequest(rawReq);
      const name = req.params.name;
      const requestOptions = createRequestOptions(extra);
      const context = getMiddlewareContext(proxyIdentity, extra.signal);
      const start = performance.now();

      const emitTelemetry = (
        outcome: ToolCallTelemetryEvent['outcome'],
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
      // Call phase: args is always an object, empty when the client sent
      // none, so a dispatcher-aware predicate can fail closed on it.
      const isHidden = isHiddenTool(name, req.params.arguments ?? {});
      // Hidden beats local; local beats upstream; pass-through never
      // applies to a local tool (it has no upstream response to forward).
      const localTool = isHidden ? undefined : localToolMap.get(name);
      const pipeline =
        !isHidden && localTool === undefined && passThroughToolSet.has(name)
          ? passThroughToolPipeline
          : toolPipeline;
      // The return type is annotated on the binding rather than on the arrow:
      // Babel, which Stryker uses to instrument this file for mutation testing,
      // cannot parse an async arrow carrying a return type inside a conditional.
      const callBackend: (
        r: CallToolRequest,
      ) => Promise<CompatibilityCallToolResult> = isHidden
        ? async () => {
            throw rejectionMcpError(
              'TOOL_HIDDEN',
              ErrorCode.MethodNotFound,
              `Tool not found: ${name}`,
            );
          }
        : localTool !== undefined
          ? (r) => localTool.handler(r.params, context)
          : mesh
            ? async (r) => {
                // Routed at the innermost `next` from the post-pipeline name,
                // so middleware can re-route a call deliberately.
                const routed = routeNamespaced(
                  r.params.name,
                  toolBackendsByKey,
                );
                if (routed === undefined) {
                  throw rejectionMcpError(
                    'BACKEND_UNROUTABLE',
                    ErrorCode.MethodNotFound,
                    `Tool not found: ${r.params.name} — a mesh exposes tools as "<backendKey>__<tool>"`,
                  );
                }
                return stripResult(
                  await routed.client.callTool(
                    { ...r.params, name: routed.name },
                    undefined,
                    requestOptions,
                  ),
                );
              }
            : upstreamHasTools
              ? async (r) =>
                  stripResult(
                    await backend.callTool(r.params, undefined, requestOptions),
                  )
              : async () => {
                  // Tools-less upstream: reject inside the pipeline rather
                  // than forwarding to an upstream that cannot serve it.
                  throw new McpError(
                    ErrorCode.MethodNotFound,
                    `Tool not found: ${name}`,
                  );
                };

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
    server.setRequestHandler(
      ListResourcesRequestSchema,
      async (rawReq, extra) => {
        const result = stripResult(
          await backend.listResources(
            stripRequest(rawReq).params,
            createRequestOptions(extra),
          ),
        );
        if (!hiddenResourceSet.size) return result;
        return {
          ...result,
          resources: result.resources.filter(
            (r) => !hiddenResourceSet.has(r.uri),
          ),
        };
      },
    );

    server.setRequestHandler(ReadResourceRequestSchema, (rawReq, extra) => {
      const req = stripRequest(rawReq);
      const uri = req.params.uri;
      const requestOptions = createRequestOptions(extra);
      const context = getMiddlewareContext(proxyIdentity, extra.signal);

      if (hiddenResourceSet.has(uri)) {
        throw rejectionMcpError(
          'RESOURCE_HIDDEN',
          ErrorCode.InvalidRequest,
          `Resource not found: ${uri}`,
        );
      }
      if (passThroughResourceSet.has(uri)) {
        return backend
          .readResource(req.params, requestOptions)
          .then(stripResult);
      }
      return resourcePipeline(
        req,
        (r) => backend.readResource(r.params, requestOptions).then(stripResult),
        context,
      );
    });
  }

  // ── Prompt handlers (pass-through) ────────────────────────────────────────

  if (capabilities.prompts && mesh) {
    // Prompt names are plain strings, so they namespace and route exactly
    // like tool names (ADR-0013).
    server.setRequestHandler(
      ListPromptsRequestSchema,
      async (_rawReq, extra) => {
        const requestOptions = createRequestOptions(extra);
        const context = getMiddlewareContext(proxyIdentity, extra.signal);
        return {
          prompts: await listAcrossMesh(
            promptBackends,
            async (client, cursor) => {
              const page = stripResult(
                await client.listPrompts(
                  cursor === undefined ? {} : { cursor },
                  requestOptions,
                ),
              );
              return { items: page.prompts, nextCursor: page.nextCursor };
            },
            (key, error) => reportDegraded(context, key, 'prompts/list', error),
          ),
        };
      },
    );

    server.setRequestHandler(GetPromptRequestSchema, (rawReq, extra) => {
      const req = stripRequest(rawReq);
      const routed = routeNamespaced(req.params.name, promptBackendsByKey);
      if (routed === undefined) {
        throw rejectionMcpError(
          'BACKEND_UNROUTABLE',
          ErrorCode.MethodNotFound,
          `Prompt not found: ${req.params.name} — a mesh exposes prompts as "<backendKey>__<prompt>"`,
        );
      }
      return routed.client
        .getPrompt(
          { ...req.params, name: routed.name },
          createRequestOptions(extra),
        )
        .then(stripResult);
    });
  } else if (capabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, (rawReq, extra) =>
      backend
        .listPrompts(stripRequest(rawReq).params, createRequestOptions(extra))
        .then(stripResult),
    );

    server.setRequestHandler(GetPromptRequestSchema, (rawReq, extra) =>
      backend
        .getPrompt(stripRequest(rawReq).params, createRequestOptions(extra))
        .then(stripResult),
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
  backends: Backends,
  options: ProxyOptions = {},
): Promise<void> {
  const server = createProxyServer(backends, options);
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
 * True for bind addresses only reachable from the local machine.
 * `127.` catches the whole 127.0.0.0/8 block Node can bind.
 */
function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '::ffff:127.0.0.1' ||
    host.startsWith('127.')
  );
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
  backends: Backends,
  options: ProxyOptions = {},
  httpOptions: HttpProxyOptions = {},
): Promise<http.Server> {
  // Sessions build their proxy server lazily, so surface configuration
  // errors (duplicate local tool names, invalid backend keys) at startup,
  // not on first initialize.
  buildLocalToolMap(options.localTools);
  normalizeBackends(backends);

  const mcpPath = httpOptions.path ?? '/mcp';
  const port = httpOptions.port ?? 3000;
  const host = httpOptions.host ?? '127.0.0.1';
  const loopback = isLoopbackHost(host);
  const dnsRebindingProtection =
    httpOptions.enableDnsRebindingProtection ?? loopback;
  // Filled in once the server is listening (the real port is only known
  // then); sessions are only created after that. The SDK transport
  // validates Host/Origin only against a non-empty list, so an enabled flag
  // without a list would be an inert control — see #74.
  let derivedAllowedHosts: string[] | undefined;
  let derivedAllowedOrigins: string[] | undefined;
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

          const proxyServer = createProxyServer(backends, options);
          // An explicit list is used verbatim; the derived loopback list
          // only fills the gap so the default actually validates something.
          const allowedHosts = httpOptions.allowedHosts ?? derivedAllowedHosts;
          const allowedOrigins =
            httpOptions.allowedOrigins ?? derivedAllowedOrigins;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            ...(eventStore ? { eventStore } : {}),
            ...(allowedHosts ? { allowedHosts } : {}),
            ...(allowedOrigins ? { allowedOrigins } : {}),
            enableDnsRebindingProtection: dnsRebindingProtection,
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
                ...(identity === undefined ? {} : { identity }),
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
          // See backendClient.ts: the SDK's transports are not assignable to
          // its own `Transport` interface under `exactOptionalPropertyTypes`
          // (here `onclose?: () => void` vs `onclose: (() => void) | undefined`).
          await proxyServer.connect(transport as Transport);
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

  if (!loopback && httpOptions.resolveIdentity === undefined) {
    reportError(
      new Error(
        `mcpose: startHttpProxy is binding non-loopback address "${host}" without resolveIdentity — ` +
          'anything that can route to this host can call the upstream with ' +
          "the proxy's credentials. Pass resolveIdentity, or bind 127.0.0.1.",
      ),
    );
  }
  // The SDK transport validates Host/Origin only against a non-empty list,
  // and no list is derived for a non-loopback bind, so this combination is
  // an inert flag — the false-confidence case the derived defaults exist
  // to remove.
  if (
    dnsRebindingProtection &&
    !loopback &&
    httpOptions.allowedHosts === undefined &&
    httpOptions.allowedOrigins === undefined
  ) {
    reportError(
      new Error(
        'mcpose: enableDnsRebindingProtection is on, but no allowedHosts or ' +
          'allowedOrigins are set and none are derived for a non-loopback ' +
          'bind, so the transport validates nothing. Pass allowedHosts ' +
          'and/or allowedOrigins.',
      ),
    );
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      // Route post-listen server errors (e.g. EMFILE) to onError instead of
      // crashing the process with an unhandled 'error' event.
      server.on('error', reportError);
      if (dnsRebindingProtection && loopback) {
        const addr = server.address();
        const actualPort =
          addr !== null && typeof addr === 'object' ? addr.port : port;
        const hosts = [
          `127.0.0.1:${actualPort}`,
          `localhost:${actualPort}`,
          `[::1]:${actualPort}`,
        ];
        const scheme = httpOptions.tlsOptions ? 'https' : 'http';
        derivedAllowedHosts = hosts;
        derivedAllowedOrigins = hosts.map((h) => `${scheme}://${h}`);
      }
      resolve(server);
    });
  });
}
