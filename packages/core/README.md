# mcpose

[![npm](https://img.shields.io/npm/v/mcpose)](https://www.npmjs.com/package/mcpose)
[![license](https://img.shields.io/npm/l/mcpose)](https://github.com/amir-gorji/mcpose/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/mcpose)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml/badge.svg)](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml)

**The composable middleware proxy for MCP.**

mcpose sits between a **client** (an LLM or agent) and an **upstream** MCP server, forwarding every tool, resource, and `list_tools` call through a **pipeline** of composable middleware.
It is a transparent proxy: the client talks to mcpose exactly as it would talk to the upstream, while you intercept, transform, hide, or govern calls in between, without touching the upstream server.

This is the core package.
For tamper-evident audit trails see [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit); for compliance assertions see [`@mcpose/testing`](https://www.npmjs.com/package/@mcpose/testing).

## Table of Contents

- [When to reach for it](#when-to-reach-for-it)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Serving over HTTP/SSE](#serving-over-httpsse)
- [Core concepts](#core-concepts)
- [API surface](#api-surface)
  - [Backend config (`BackendConfig`)](#backend-config-backendconfig)
  - [Proxy options (`ProxyOptions`)](#proxy-options-proxyoptions)
  - [HTTP options (`HttpProxyOptions`)](#http-options-httpproxyoptions)
  - [Context and identity](#context-and-identity)
  - [Rejection reasons](#rejection-reasons)
  - [Test helpers: `mcpose/testing`](#test-helpers-mcposetesting)
- [The mcpose ecosystem](#the-mcpose-ecosystem)
- [Documentation](#documentation)
- [License](#license)

## When to reach for it

- Add cross-cutting behavior (logging, PII redaction, identity resolution, rate limiting) to an MCP server you do not own.
- Hide or gate specific tools and resources per caller, with a structured reason rather than an opaque error.
- Resolve a caller **identity** once per session and read it from every request in that session.
- Lay the foundation for compliance-grade audit trails with [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit).

If you own the single MCP server and need one hook in one place, a request handler in that server is simpler than a proxy hop.
mcpose earns its keep when the concern is cross-cutting, the server is not yours, or the behavior has to be tested independently of any one server.

## Features

- **Transparent proxy**: wrap any upstream MCP server without modifying it.
- **Composable middleware pipeline** with a predictable onion model: each layer runs before *and* after the layers inside it.
- **Per-session identity resolution**: resolve a caller once, then read the same `Identity` from every request in the session.
- **Tool and resource governance**: hide tools, gate them per caller, or pass them straight through the pipeline.
- **Dual transport**: stdio (lightweight, process-local) or HTTP/SSE with mTLS, session limits, and SSE reconnect replay.
- **ESM-first**: native ESM with first-class TypeScript types, and no runtime dependencies beyond the MCP SDK.

## Install

```bash
npm install mcpose @modelcontextprotocol/sdk
```

Requires Node.js 20+.
`@modelcontextprotocol/sdk` (`^1.17.0`) is a peer dependency you install yourself.

## Quick start

Connect to an upstream over stdio, add one middleware, and serve the proxy:

```ts
import { createBackendClient, startProxy } from 'mcpose';
import type { ToolMiddleware } from 'mcpose';

// 1. Connect to the upstream MCP server (stdio).
const backend = await createBackendClient({
  command: 'node',
  args: ['/path/to/backend-server.mjs'],
});

// 2. Define middleware: (req, next, ctx) => Promise<result>
const loggingMW: ToolMiddleware = async (req, next) => {
  console.error(`→ ${req.params.name}`);
  const result = await next(req);
  console.error(`← ${req.params.name} done`);
  return result;
};

// 3. Start the proxy on stdio.
await startProxy(backend, { toolMiddleware: [loggingMW] });
```

Point your MCP client at this process instead of the upstream, and every tool call flows through `loggingMW`.

## Serving over HTTP/SSE

`startHttpProxy` adds per-session identity resolution, mTLS, session limits, and SSE reconnect replay:

```ts
import { createBackendClient, startHttpProxy } from 'mcpose';

// Supplied by your application:
//   extractJwt: a resolveIdentity function returning an Identity from the request
const backend = await createBackendClient({ url: 'http://localhost:9000/mcp' });

const server = await startHttpProxy(
  backend,
  { toolMiddleware: [loggingMW] },
  {
    port: 3000,
    resolveIdentity: extractJwt, // stamped on every ProxyContext in the session
    onSessionClosed: (sessionId) => {/* flush audit manifest, etc. */},
  },
);
```

The returned `http.Server` is already listening; call `.close()` to shut down.
Active proxy sessions are closed before the underlying server finishes closing.

Behavior worth knowing before you deploy it:

- **The proxy binds loopback by default.** `host` defaults to `127.0.0.1`, DNS-rebinding protection is on for loopback binds with `allowedHosts` / `allowedOrigins` derived from the effective bind address and real listening port, and a non-loopback bind without `resolveIdentity` reports a startup warning through `onError`.
  See [ADR-0005](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0005-loopback-bind-by-default.md).
- **Session creation is restricted.** Only an `initialize` POST can create a session; a session-less GET or DELETE returns 400.
- **Sessions can be re-validated per request.** `validateSession(req, { sessionId, identity })` runs on every routed request; return `false` or throw for a 401.
  Use it to bind a session to its original credential, so a leaked `mcp-session-id` alone cannot take a session over.
- **Credential headers never reach middleware.** `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, and `x-api-key` are stripped from `ProxyContext.headers`, and with that from anything middleware logs.
  `resolveIdentity` reads the raw `http.IncomingMessage`, so it still sees them.
- **`onSessionClosed` fires on every session-end path**: client DELETE, TTL expiry, and server shutdown, so audit manifests flush in all three cases.
- **Limit breaches are structured.** 503 (session limit) and 413 (body limit) responses carry `error.data.rejectionReason` set to `SESSION_LIMIT` / `BODY_LIMIT`.
- **SSE replay is scoped per stream.** The in-memory store replays only events from the reconnecting stream; an unknown or already-evicted `Last-Event-ID` replays nothing.

## Core concepts

- **Middleware**: a single function `(req, next, ctx) => Promise<result>`.
  Call `next(req)` to delegate inward; transform the request before, or the response after.
  Middlewares nest onion-style.
- **Pipeline**: middleware passed to `ProxyOptions` runs in **response-processing order**, so the first element processes the response first and is therefore the innermost layer.
  `[piiMW, auditMW]` redacts before it audits.
  Note that `compose()` uses the opposite, outermost-first convention, so the two are not interchangeable.
  See [ADR-0002](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0002-proxy-options-array-response-processing-order.md).
- **ProxyContext**: per-request metadata threaded through the pipeline: `requestId`, `transport`, `sessionId`, the resolved `identity`, and the `delegatedFrom` delegation chain.

## API surface

| Export | Purpose |
|---|---|
| `createBackendClient(config)` | Connect to an upstream over stdio (`command`/`args`) or HTTP (`url`). |
| `startProxy(backend, options?)` | Serve the proxy over **stdio**. Resolves when the transport closes. |
| `startHttpProxy(backend, proxyOptions?, httpOptions?)` | Serve over **HTTP/SSE**: identity, mTLS, sessions, reconnect replay. Resolves with a listening `http.Server`. |
| `createProxyServer(backend, options?)` | Build the underlying `Server` without binding a transport. Throws if the backend is not connected, so a mis-wired proxy fails at startup rather than on the first call. |
| `compose(middlewares)` | Compose middleware into one, **outermost-first**. |
| `markPassThroughObserver(mw)` | Return a new middleware that still runs for `passThroughTools`. For observers only, never transformers. |
| `rejectionMcpError(reason, code, message)` | Build an `McpError` carrying a `RejectionReason` in `error.data`. |
| `createProxyContext(overrides?)` | Construct a `ProxyContext`. Useful in tests. |
| `createInMemoryEventStore()` | Default SSE reconnect event store; swap for a `PersistentEventStore`. |
| `hasToolContent(result)` | Type guard narrowing `CompatibilityCallToolResult` to `CallToolResult`. |
| `dispatcherAwareBlock(options)` | `HiddenToolPredicate` blocking hidden tools both directly and through dispatcher (meta) tools. Fail-closed. |

**Key types:** `Middleware<Req, Res>`, `ToolMiddleware`, `ResourceMiddleware`, `ListToolsMiddleware`, `ProxyContext`, `Identity`, `BackendConfig`, `ProxyOptions`, `HttpProxyOptions`, `HiddenToolPredicate`, `RejectionReason`, `TelemetryEvent`, `PersistentEventStore`.

`PersistentEventStore` is an alias of the SDK's `EventStore` type, so any SDK-compatible store plugs in directly.

### Backend config (`BackendConfig`)

`createBackendClient` accepts a `BackendConfig` describing how to reach the upstream, in one of two modes.

| Field | Mode | Description |
|---|---|---|
| `command` | stdio | Executable to spawn for the backend (e.g. `"node"`). |
| `args` | stdio | Arguments passed to `command` (e.g. `["/path/to/server.mjs"]`). |
| `url` | HTTP/SSE | URL of a running backend. Takes precedence over stdio. |
| `headers` | HTTP/SSE | Custom headers sent on every request to the backend. Ignored in stdio mode. |
| `authProvider` | HTTP/SSE | `OAuthClientProvider` for interactive OAuth with transparent token refresh. Ignored in stdio mode. |

Use `headers` to authenticate with the upstream using a static credential:

```ts
const backend = await createBackendClient({
  url: 'https://mcp.example.com/sse',
  headers: { Authorization: `Bearer ${process.env.UPSTREAM_TOKEN}` },
});
```

For upstreams that require OAuth rather than a static token, pass an `authProvider`.
mcpose forwards it to the HTTP/SSE transport, which runs the MCP OAuth flow (browser authorization plus transparent refresh) so you do not manage tokens yourself.

```ts
import { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth';

const authProvider: OAuthClientProvider = {
  // redirectUrl, clientMetadata, and the token/authorization-code callbacks
};

const backend = await createBackendClient({ url: 'https://mcp.example.com/sse', authProvider });
```

See [`oauth-upstream-client.ts`](https://github.com/amir-gorji/mcpose/blob/main/examples/oauth-upstream-client.ts) for a complete implementation.

### Proxy options (`ProxyOptions`)

<details>
<summary>Show the <code>ProxyOptions</code> interface</summary>

```ts
interface ProxyOptions {
  name?:                 string;
  version?:              string;
  toolMiddleware?:       ReadonlyArray<ToolMiddleware>;
  resourceMiddleware?:   ReadonlyArray<ResourceMiddleware>;
  listToolsMiddleware?:  ReadonlyArray<ListToolsMiddleware>;
  passThroughTools?:     ReadonlyArray<string>;
  passThroughResources?: ReadonlyArray<string>;
  hiddenTools?:          ReadonlyArray<string> | HiddenToolPredicate;
  hiddenResources?:      ReadonlyArray<string>;
  localTools?:           ReadonlyArray<LocalTool>;
  stripRequestMeta?:     boolean;  // Default: true
  onTelemetry?:          (event: TelemetryEvent) => void;
}

interface LocalTool {
  tool: Tool;  // advertised in tools/list
  handler: (params: CallToolRequestParams, context: ProxyContext) => Promise<CallToolResult>;
}
```

</details>

- `name` and `version` set the MCP server identity returned in `initialize`.
  `name` defaults to `'mcpose'` and `version` to the mcpose library version, so set your own when you ship a proxy.
- `hiddenTools` / `hiddenResources` reject calls with a structured [`RejectionReason`](#rejection-reasons) in the MCP error `data` field.
  The rejection is thrown *inside* the pipeline, so observing middleware such as audit records it; the upstream is never called.
- `hiddenTools` also accepts a `HiddenToolPredicate` (`(name, args) => boolean`), because a name array cannot see through a dispatcher (meta-tool) that takes the real tool name as an argument.
  The predicate receives `undefined` args during list filtering and always an object at call time, so it can keep the dispatcher listed while failing closed on a malformed call.
  `dispatcherAwareBlock({ tools, dispatchers, argPath })` implements the common case and blocks whenever the target name is missing or is not a string.
  See [ADR-0006](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0006-hidden-tools-accept-a-predicate.md).
- `passThroughTools` / `passThroughResources` skip transforming middleware, but middleware wrapped in `markPassThroughObserver()` still runs for them.
  A tool that is both hidden and pass-through stays hidden.
- `localTools` are tools the proxy implements itself.
  They appear in `tools/list` (first page only, so pagination does not duplicate them), route to their handler instead of the upstream, and still run through the full `toolMiddleware` pipeline, so audit and redaction apply to them.
  Precedence: `hiddenTools` beats a local tool, a local tool beats (and shadows) an upstream tool of the same name, and `passThroughTools` does not apply to local tools.
  The proxy advertises the `tools` capability when `localTools` is non-empty even if the upstream has none, and a duplicate local tool name throws at `createProxyServer`.
  See [ADR-0007](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0007-local-tools-run-the-full-pipeline.md).
- `stripRequestMeta` (default `true`) removes `params._meta` from every forwarded request, tool calls, resource reads, list and prompt calls alike, because MCP clients put correlation identifiers there (VS Code sends `progressToken`, a W3C `traceparent`, and `vscode/conversationId`) and the upstream is frequently a third party.
  The strip happens at the proxy boundary before the pipeline, so middleware can still add `_meta` deliberately, and it applies to pass-through tools too; disable only globally with `stripRequestMeta: false`.
  Progress relay is unaffected: the proxy reads the client's progress token from the request `extra`, and the SDK client stamps its own token on the upstream request.
  See [ADR-0008](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0008-strip-request-meta.md).
- `onTelemetry` fires after every tool call with timing, outcome, tool name, and identity.
  Results with `isError: true` are reported as outcome `'error'`, and a throwing sink is logged but never fails the call.
  An OpenTelemetry adapter (`@mcpose/otel`) is planned for v3.

### HTTP options (`HttpProxyOptions`)

<details>
<summary>Show the <code>HttpProxyOptions</code> interface and <code>startHttpProxy()</code> signature</summary>

```ts
interface HttpProxyOptions {
  port?: number;         // Default: 3000
  host?: string;         // Default: '127.0.0.1' (loopback); non-loopback is a deliberate opt-in
  path?: string;         // Default: '/mcp'
  onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean | Promise<boolean>;
  onError?: (err: unknown) => void;
  maxBodyBytes?: number; // Default: 4 MB (4,194,304); excess returns 413
  maxSessions?: number;  // Excess requests return 503
  sessionTtlMs?: number; // Sessions auto-close after this duration
  /** Resolves caller identity once per session. Errors abort the session with 401. */
  resolveIdentity?: (req: http.IncomingMessage) => Identity | Promise<Identity>;
  /** Re-validates an existing session on every routed request. Return false (or throw) for a 401. */
  validateSession?: (
    req: http.IncomingMessage,
    session: { sessionId: string; identity?: Identity },
  ) => boolean | Promise<boolean>;
  /** mTLS: Node's https.ServerOptions (key, cert, ca, requestCert, rejectUnauthorized). */
  tlsOptions?: https.ServerOptions;
  /** SSE reconnect replay store. Defaults to in-memory. Pass null to disable. */
  eventStore?: PersistentEventStore | null;
  /** Called when a session closes: client DELETE, TTL expiry, or server shutdown. */
  onSessionClosed?: (sessionId: string) => void;
  /** Hosts allowed in the Host header. Default: derived from the bind address and real port on loopback. */
  allowedHosts?: string[];
  /** Origins allowed in the Origin header. Default: derived, matching allowedHosts. */
  allowedOrigins?: string[];
  /** SDK Host/Origin checks. Default: true on a loopback bind, false otherwise. */
  enableDnsRebindingProtection?: boolean;
}

function startHttpProxy(
  backend: BackendClient,
  options?: ProxyOptions,
  httpOptions?: HttpProxyOptions,
): Promise<http.Server>;
```

</details>

`httpOptions` is meaningful only for HTTP/SSE transport; omit it when serving over stdio.
`allowedHosts`, `allowedOrigins`, and `enableDnsRebindingProtection` are forwarded to the SDK transport, which only validates against a non-empty list; that is why mcpose derives enforcing defaults for a loopback bind instead of shipping an inert flag.
An explicit `allowedHosts` or `allowedOrigins` is used verbatim and never merged with the derived list.
See [ADR-0005](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0005-loopback-bind-by-default.md) and the network posture section of [`SECURITY.md`](https://github.com/amir-gorji/mcpose/blob/main/SECURITY.md).
The behavioral notes in [Serving over HTTP/SSE](#serving-over-httpsse) apply to all of these.

### Context and identity

Every middleware receives a normalized `ProxyContext` as its third argument.

<details>
<summary>Show <code>ProxyContext</code>, <code>Identity</code>, and the middleware types</summary>

```ts
interface ProxyContext {
  requestId: string;
  transport: 'stdio' | 'http';
  sessionId?: string;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** Resolved caller identity. Present when resolveIdentity is configured. */
  identity?: Identity;
  /** Agent delegation chain. Stamped by the host; core does not populate it yet. */
  delegatedFrom?: Identity[];
  /** Reserved for the v3 policy engine. */
  policy?: never;
}

interface Identity {
  sub: string;
  type: 'human' | 'agent' | 'service';
  displayName?: string;
  roles: string[];
  claims: Record<string, unknown>;
  resolvedAt: string;  // ISO 8601
  source: 'jwt' | 'mtls' | 'apikey' | 'custom';
}

type Middleware<Req, Res> = (
  req: Req,
  next: (req: Req) => Promise<Res>,
  context: ProxyContext,
) => Promise<Res>;

type ToolMiddleware      = Middleware<CallToolRequest, CompatibilityCallToolResult>;
type ResourceMiddleware  = Middleware<ReadResourceRequest, ReadResourceResult>;
type ListToolsMiddleware = Middleware<ListToolsRequest, ListToolsResult>;
```

</details>

`sessionId` is present on HTTP transport only.
Over stdio there is no session concept, which is why `@mcpose/audit` produces no `ReplayManifest` there.

`delegatedFrom` records agent-to-agent handoffs, but core does not extract it from requests yet: it is populated only when your host application places it on the context.
A delegation header spec is v3 work.

### Rejection reasons

Every blocked call embeds a `RejectionReason` in the MCP error `data` field.
The top-level error code is unchanged, so clients that only inspect the code are unaffected, while audit middleware and agents can branch on `error.data.rejectionReason`.

Use `rejectionMcpError(reason, code, message)` to reject from your own middleware in the same structured shape the proxy uses.

<details>
<summary>Show the <code>RejectionReason</code> union</summary>

```ts
type RejectionReason =
  | 'TOOL_HIDDEN'           // tool exists but is hidden from this caller
  | 'RESOURCE_HIDDEN'       // resource exists but is hidden from this caller
  | 'POLICY_DENIED'         // v3: RBAC policy blocked the call
  | 'IDENTITY_UNRESOLVED'   // v3: identity could not be established
  | 'CONSENT_MISSING'       // v3: GDPR/CCPA consent gate blocked the call
  | 'SENSITIVITY_BLOCKED'   // v3: data sensitivity policy blocked the call
  | 'DELEGATION_INVALID'    // v3: agent delegation chain is invalid or expired
  | 'BUDGET_EXCEEDED'       // v3: cost budget for this session/user exceeded
  | 'SESSION_LIMIT'         // max concurrent sessions reached (HTTP 503)
  | 'BODY_LIMIT';           // request body exceeded maxBodyBytes (HTTP 413)
```

</details>

The values marked v3 are reserved: the union is declared now so that `error.data` consumers written today keep compiling when the policy engine lands.

### Test helpers: `mcpose/testing`

The core package exposes proxy and middleware test utilities under a subpath:

```ts
import {
  createMockBackendClient,
  runToolMiddleware,
  runListToolsMiddleware,
  runResourceMiddleware,
} from 'mcpose/testing';
```

`createMockBackendClient()` returns an in-memory backend stub with capability lookup and notification hooks.
It works with both `createProxyServer()` and `startHttpProxy()` tests, so an example or test suite needs no real upstream.
`runToolMiddleware()`, `runListToolsMiddleware()`, and `runResourceMiddleware()` drive a single middleware in isolation; each takes the middleware, the request, a `next`, and an optional `ProxyContext` that defaults to a fresh `createProxyContext()`, so tests never pass `undefined as never` for the context argument.
`runToolMiddleware()` additionally narrows away the legacy `{ toolResult }` shape; the list and resource results have no legacy variant, so the other two have nothing to narrow.

> **Not to be confused with** [`@mcpose/testing`](https://www.npmjs.com/package/@mcpose/testing), a separate package of compliance assertions over audit chains.
> This subpath mocks the proxy; that package verifies the audit trail.

## The mcpose ecosystem

| Package | What it adds |
|---|---|
| **`mcpose`** (this package) | Proxy core: pipeline, transports, identity, governance. |
| [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit) | Tamper-evident HMAC-chained audit events and a signed Merkle `ReplayManifest`. |
| [`@mcpose/testing`](https://www.npmjs.com/package/@mcpose/testing) | Runner-agnostic compliance assertions over an audit trail. |

## Documentation

- [Project README](https://github.com/amir-gorji/mcpose#readme): concepts, comparison, guides, and examples
- [`CONTEXT.md`](https://github.com/amir-gorji/mcpose/blob/main/CONTEXT.md): the canonical domain glossary
- [Architecture decision records](https://github.com/amir-gorji/mcpose/tree/main/docs/adr)
- [Runnable examples](https://github.com/amir-gorji/mcpose/tree/main/examples)

## License

MIT © Amir Gorji
