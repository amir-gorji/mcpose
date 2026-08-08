<p align="center">
  <img src="assets/logo.png" alt="mcpose logo" width="500" />
</p>

# mcpose

[![npm](https://img.shields.io/npm/v/mcpose)](https://www.npmjs.com/package/mcpose)
[![license](https://img.shields.io/npm/l/mcpose)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml/badge.svg)](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-025E8C?logo=dependabot)](https://github.com/amir-gorji/mcpose/blob/main/.github/dependabot.yml)

The audit and governance layer for MCP.

mcpose is a transparent middleware proxy for MCP servers. It intercepts, transforms, and governs tool calls through composable functional middleware, and with `@mcpose/audit`, produces tamper-evident, compliance-grade audit trails that satisfy DORA Article 17 and SR 11-7 requirements.

## Features

- **Transparent proxy**: wrap any upstream MCP server without modifying it.
- **Composable middleware** with a predictable onion model: each layer runs before *and* after the inner pipeline.
- **Hide or gate tools and resources** per caller, with a structured `RejectionReason` in every blocked call.
- **Per-session identity resolution**: resolve a caller once, then stamp the `Identity` on every request in the session.
- **Compliance-grade audit trails** (DORA Art. 17, SR 11-7) via [`@mcpose/audit`](#mcposeaudit): HMAC-chained events, a Merkle `ReplayManifest`, and AES-256-GCM for high-sensitivity tiers.
- **HTTP/SSE transport** with mTLS, session limits, and SSE reconnect replay.
- **Production-minded**: ships ESM with first-class TypeScript types and runs on Node.js 20+.

## When to use mcpose

- You operate MCP servers in a regulated environment (finance, healthcare) and need PII redaction, caller identity, and a tamper-evident audit trail on every tool call.
- You want to add cross-cutting behavior (logging, redaction, rate limiting, governance) to an MCP server you do not control.
- You need to hide or gate specific tools and resources per caller, or stamp a resolved identity onto every request.

## Table of Contents

- [Features](#features)
- [When to use mcpose](#when-to-use-mcpose)
- [New in 2.0](#new-in-20)
- [Background](#background)
- [Concept](#concept)
- [Packages](#packages)
- [Install](#install)
- [Quick Start](#quick-start)
- [Proxy model](#proxy-model)
- [Middleware model](#middleware-model)
- [API Reference](#api-reference)
- [@mcpose/audit](#mcposeaudit)
- [@mcpose/testing](#mcposetesting)
- [Recipe: PII redaction + audit](#recipe-pii-redaction--audit)
- [Recipe: list_tools rewriting](#recipe-list_tools-rewriting)
- [Examples](#examples)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## New in 2.0

- **`@mcpose/audit`**: HMAC-chained audit events, Merkle-proof `ReplayManifest`, AES-256-GCM encryption for high-sensitivity tiers, `createSensitivityResolver`, `createDefaultSigningKeyProvider`
- **`@mcpose/testing`**: compliance assertion helpers: `assertAuditChainIntegrity`, `assertReplayManifestValid`, `assertPiiRedacted`, `assertDelegationHonored`
- **Identity resolution**: `resolveIdentity` hook on `HttpProxyOptions`; resolved `Identity` stamped on every `ProxyContext`
- **Agent delegation chain**: `delegatedFrom?: Identity[]` on `ProxyContext` for A2A handoff recording
- **mTLS**: pass `tlsOptions` to `startHttpProxy` for mutual TLS
- **SSE reconnect replay**: built-in in-memory `EventStore` with the `PersistentEventStore` type (an alias of the SDK's `EventStore`) for Redis/Postgres adapters
- **Session lifecycle hook**: `onSessionClosed` on `HttpProxyOptions`; wire `auditHandle.closeSession` here to flush `ReplayManifest` on session end
- **Structured rejection reasons**: `RejectionReason` in MCP error `data` field on every blocked call

---

## Background

mcpose was extracted from [`financial-elastic-mcp-server`](https://github.com/amir-gorji/financial-elastic-mcp-server), an Elasticsearch MCP server built for financial institutions that needed PII redaction and audit logging on every tool call. Those cross-cutting concerns were originally hardcoded into a single server. mcpose lifts that pattern into a reusable, composable middleware layer that can wrap **any** upstream MCP server.

---

## Concept

mcpose is a **transparent proxy** between an LLM client and an upstream MCP server. It mirrors the upstream MCP surface and routes supported calls through middleware. The client sees a normal MCP server; the upstream sees a normal MCP client.

---

## Packages

This is a monorepo. Each package publishes independently and has its own README on npm.

| Package | npm | What it does |
|---|---|---|
| [`mcpose`](./packages/core/README.md) | [![npm](https://img.shields.io/npm/v/mcpose)](https://www.npmjs.com/package/mcpose) | Proxy core: pipeline, transports, identity, governance. |
| [`@mcpose/audit`](./packages/audit/README.md) | [![npm](https://img.shields.io/npm/v/@mcpose/audit)](https://www.npmjs.com/package/@mcpose/audit) | Tamper-evident HMAC audit chain + Merkle `ReplayManifest`. |
| [`@mcpose/testing`](./packages/testing/README.md) | [![npm](https://img.shields.io/npm/v/@mcpose/testing)](https://www.npmjs.com/package/@mcpose/testing) | Runner-agnostic compliance assertions for the audit chain. |

---

## Install

**Prerequisites**

- Node.js 20 or newer.
- `@modelcontextprotocol/sdk` as a peer dependency (installed separately below).
- For compliance audit trails, also install [`@mcpose/audit`](#mcposeaudit).

```bash
npm install mcpose
```

**Peer dependency**: must be installed separately:

```bash
npm install @modelcontextprotocol/sdk@>=1.0.0
```

For compliance audit trails:

```bash
npm install @mcpose/audit
```

---

## Quick Start

```ts
import { createBackendClient, startProxy } from 'mcpose';
import type { ToolMiddleware } from 'mcpose';

// 1. Connect to the upstream MCP server (stdio)
const backend = await createBackendClient({
  command: 'node',
  args: ['/path/to/backend-server.mjs'],
});

// 2. Define middleware
const loggingMW: ToolMiddleware = async (req, next) => {
  console.error(`→ ${req.params.name}`);
  const result = await next(req);
  console.error(`← ${req.params.name} done`);
  return result;
};

// 3. Start the proxy on stdio
await startProxy(backend, {
  toolMiddleware: [loggingMW],
});
```

---

## Proxy model

```
┌──────────────┐        ┌────────────────────────────────┐        ┌────────────────────┐
│  LLM client  │ ◄────► │  mcpose                        │ ◄────► │  Upstream MCP      │
│  (Claude,    │        │  · identity resolution         │        │  server            │
│   Cursor…)   │        │  · visibility filters          │        │  (stdio or HTTP)   │
└──────────────┘        │  · middleware pipelines        │        └────────────────────┘
                        │  · audit trail                 │
                        └────────────────────────────────┘
```

For each supported tool or resource, mcpose picks one of three routing paths:

| Path | Option | Behavior |
|---|---|---|
| **Hidden** | `hiddenTools` / `hiddenResources` | Omitted from list responses; rejected with `TOOL_HIDDEN` / `RESOURCE_HIDDEN` at call time |
| **Pass-through** | `passThroughTools` / `passThroughResources` | Forwarded raw to upstream; transforming middleware skipped |
| **Middleware** | everything else | Routed through the full `toolMiddleware` / `resourceMiddleware` pipeline |

For hidden tools, the rejection is thrown inside the middleware pipeline, so middleware such as audit observes the rejected call; the backend is never called.
A tool listed in both `hiddenTools` and `passThroughTools` stays hidden.
Pass-through skips transforming middleware only: middleware wrapped in `markPassThroughObserver()` (audit, telemetry) still runs for pass-through tools.
Prompts are forwarded as-is when the upstream supports prompts.

The proxy preserves core request semantics end to end:

- advertised capabilities are mirrored from the upstream server
- abort signals are forwarded to upstream tool, resource, and prompt calls
- upstream progress updates are relayed back to the downstream client
- list-changed notifications are advertised and fanned out when the upstream supports them
- `list_tools` responses can be transformed through `listToolsMiddleware` without weakening local `hiddenTools` guarantees (hidden filtering is applied both before and after the middleware)

---

## Middleware model

Middleware follows the **onion model**: outer layers run code before *and* after inner layers. Each middleware receives the request, a `next` function to invoke the rest of the pipeline, and a normalized `ProxyContext`.

```
  request ──►
             ┌──────────────────────────────────────────┐
             │  outerMW  (enter)                        │
             │  ┌────────────────────────────────────┐  │
             │  │  innerMW  (enter)                  │  │
             │  │  ┌──────────────────────────────┐  │  │
             │  │  │  upstream call               │  │  │
             │  │  └──────────────────────────────┘  │  │
             │  │  innerMW  (exit) ◄── response      │  │
             │  └────────────────────────────────────┘  │
             │  outerMW  (exit) ◄── response            │
             └──────────────────────────────────────────┘
  ◄── response
```

**Array order in `ProxyOptions`** uses **response-processing order**: the first element processes the response *first* (innermost layer). To guarantee audit never sees raw PII:

```ts
toolMiddleware: [piiMW, auditMW]
// Execution:
// 1. auditMW enter  → capture startTime         (outermost)
// 2. piiMW enter    → transform request
// 3. upstream call
// 4. piiMW exit     → redact PII from response  (processes response first)
// 5. auditMW exit   → log already-clean data    (processes response last)
```

`compose([outerMW, innerMW])` uses the **opposite** (outermost-first) convention: `ProxyOptions` arrays are **not** interchangeable with `compose()` arguments.

Middleware that must observe every call regardless of pass-through status (audit, telemetry) can be wrapped in `markPassThroughObserver(mw)`.
A wrapped middleware still runs for tools listed in `passThroughTools`, which skip all other middleware.
Never use it for middleware that transforms requests or responses: pass-through means "forward upstream as-is".

```ts
import { markPassThroughObserver } from 'mcpose';

toolMiddleware: [piiMW, markPassThroughObserver(metricsMW)]
// piiMW is skipped for passThroughTools; metricsMW still sees every call.
```

The middleware returned by `createAuditMiddleware` in `@mcpose/audit` is already wrapped, so pass-through tools stay audited without extra setup.

---

## API Reference

> The canonical API reference for each package lives in its own README: [`packages/core`](./packages/core/README.md), [`@mcpose/audit`](./packages/audit/README.md), and [`@mcpose/testing`](./packages/testing/README.md).
> The full type signatures are reproduced below, with the dense reference collapsed for scannability.

### `ProxyContext` · `Middleware<Req, Res>` · `ToolMiddleware` · `ResourceMiddleware` · `ListToolsMiddleware` · `compose()` · `markPassThroughObserver()` · `createProxyContext()`

The per-request `ProxyContext`, the `Identity` shape, the middleware type aliases, and the `hasToolContent` type guard.

<details>
<summary>Show type definitions</summary>

```ts
interface ProxyContext {
  requestId: string;
  transport: 'stdio' | 'http';
  sessionId?: string;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** Resolved caller identity. Present when resolveIdentity is configured. */
  identity?: Identity;
  /** Agent delegation chain: populated from A2A handoff headers. */
  delegatedFrom?: Identity[];
  /** Reserved for v3 policy engine. */
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

function createProxyContext(overrides?: Partial<ProxyContext>): ProxyContext;

type Middleware<Req, Res> = (
  req: Req,
  next: (req: Req) => Promise<Res>,
  context: ProxyContext,
) => Promise<Res>;

type ToolMiddleware     = Middleware<CallToolRequest, CompatibilityCallToolResult>;
type ResourceMiddleware = Middleware<ReadResourceRequest, ReadResourceResult>;
type ListToolsMiddleware = Middleware<ListToolsRequest, ListToolsResult>;

// Type guard: narrows CompatibilityCallToolResult to CallToolResult
function hasToolContent(r: CompatibilityCallToolResult): r is CallToolResult;

// Wraps a middleware so it still runs for passThroughTools (returns a new
// middleware; the input is not mutated). Use for observers, never transformers.
function markPassThroughObserver<Req, Res>(mw: Middleware<Req, Res>): Middleware<Req, Res>;
```

</details>

---

### `BackendConfig` · `createBackendClient()`

```ts
interface BackendConfig {
  command?: string;   // Executable to spawn for stdio transport (e.g., "node")
  args?:    string[]; // Arguments for the spawned process
  url?:     string;   // HTTP endpoint of a running MCP server (takes precedence over stdio)
}

async function createBackendClient(config: BackendConfig): Promise<BackendClient>;
```

---

### `ProxyOptions` · `startProxy()` · `createProxyServer()`

Middleware arrays, visibility filters (`hiddenTools` / `passThroughTools`), and the telemetry hook.

<details>
<summary>Show the <code>ProxyOptions</code> interface and entry-point signatures</summary>

```ts
interface ProxyOptions {
  name?:                 string;
  version?:              string;
  toolMiddleware?:       ReadonlyArray<ToolMiddleware>;
  resourceMiddleware?:   ReadonlyArray<ResourceMiddleware>;
  listToolsMiddleware?:  ReadonlyArray<ListToolsMiddleware>;
  passThroughTools?:     ReadonlyArray<string>;
  passThroughResources?: ReadonlyArray<string>;
  hiddenTools?:          ReadonlyArray<string>;
  hiddenResources?:      ReadonlyArray<string>;
  onTelemetry?:          (event: TelemetryEvent) => void;
}

async function startProxy(backend: BackendClient, options?: ProxyOptions): Promise<void>;
function createProxyServer(backend: BackendClient, options?: ProxyOptions): Server;
```

</details>

`name` and `version` set the MCP server identity returned in `initialize`.
Both are optional: `name` defaults to `'mcpose'`, and `version` defaults to the mcpose library version, so set your own when you ship a proxy.

`onTelemetry` fires after every tool call with timing, outcome, tool name, and identity.
Wire it to any custom sink; an OpenTelemetry adapter (`@mcpose/otel`) is planned for v3.
Results with `isError: true` are reported as outcome `'error'`, and a throwing sink is logged but never fails the tool call.

`createProxyServer` throws if the backend is not connected, so a mis-wired proxy fails at startup instead of on the first call.

---

### `HttpProxyOptions` · `startHttpProxy()`

The HTTP/SSE entry point: port/host/path, body and session limits, per-session identity resolution, mTLS, and the SSE reconnect replay store.

<details>
<summary>Show the <code>HttpProxyOptions</code> interface and <code>startHttpProxy()</code> signature</summary>

```ts
interface HttpProxyOptions {
  port?: number;         // Default: 3000
  host?: string;         // Default: all interfaces
  path?: string;         // Default: '/mcp'
  onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean | Promise<boolean>;
  onError?: (err: unknown) => void;
  maxBodyBytes?: number; // Default: 4 MB; returns 413 on excess
  maxSessions?: number;  // Excess requests return 503
  sessionTtlMs?: number; // Sessions auto-close after this duration
  /** Resolves caller identity once per session. Errors abort the session with 401. */
  resolveIdentity?: (req: http.IncomingMessage) => Identity | Promise<Identity>;
  /** Re-validates an existing session on every routed request. Return false (or throw) for a 401. */
  validateSession?: (
    req: http.IncomingMessage,
    session: { sessionId: string; identity?: Identity },
  ) => boolean | Promise<boolean>;
  /** mTLS: pass Node's https.ServerOptions (key, cert, ca, requestCert, rejectUnauthorized). */
  tlsOptions?: https.ServerOptions;
  /** SSE reconnect replay store. Defaults to in-memory. Pass null to disable.
   *  PersistentEventStore is an alias of the SDK's EventStore type. */
  eventStore?: PersistentEventStore | null;
  /** Called when a session closes: client DELETE, TTL expiry, or server shutdown. */
  onSessionClosed?: (sessionId: string) => void;
  /** Hosts allowed in the Host header when DNS-rebinding protection is on. Forwarded to the SDK transport. */
  allowedHosts?: string[];
  /** Origins allowed in the Origin header. Forwarded to the SDK transport. */
  allowedOrigins?: string[];
  /** Enables the SDK transport's Host/Origin checks. Recommended for localhost proxies. */
  enableDnsRebindingProtection?: boolean;
}

function startHttpProxy(
  backend: BackendClient,
  options?: ProxyOptions,
  httpOptions?: HttpProxyOptions,
): Promise<http.Server>;
```

</details>

```ts
import { createBackendClient, startHttpProxy } from 'mcpose';

const backend = await createBackendClient({ url: 'http://upstream-mcp-server/mcp' });
const server = await startHttpProxy(backend, { toolMiddleware: [loggingMW] }, { port: 8080 });
```

On shutdown, active proxy sessions are closed before the underlying `http.Server` finishes closing.
`onSessionClosed` fires on every session-end path: client DELETE, TTL expiry, and server shutdown, so audit manifests flush in all three cases.

Only an `initialize` POST can create a session; a session-less GET or DELETE returns 400.
Use `validateSession` to bind a session to its original credential (for example, re-check the bearer token) so a leaked `mcp-session-id` alone cannot take over a session.

Credential-bearing headers (`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`) are stripped from `ProxyContext.headers` before middleware (and through it, audit logs) can see them; `resolveIdentity` reads the raw `http.IncomingMessage`, so it still sees them.

503 (session limit) and 413 (body limit) responses carry a JSON body with `error.data.rejectionReason` set to `SESSION_LIMIT` / `BODY_LIMIT`.

SSE reconnect replay is scoped per stream: the in-memory store replays only events from the reconnecting stream, and an unknown or already-evicted `Last-Event-ID` replays nothing.

---

### `RejectionReason` · `rejectionMcpError()`

Every blocked call embeds a `RejectionReason` in the MCP error `data` field.
The top-level error code is unchanged, so existing clients that only inspect the code are unaffected.
Audit middleware and agents can inspect `error.data.rejectionReason` for programmatic handling.

`rejectionMcpError(reason, code, message)` builds an `McpError` with the reason embedded in `error.data`, so custom middleware can reject calls in the same structured shape the proxy uses.

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

---

### `mcpose/testing`

```ts
import { createMockBackendClient, runToolMiddleware } from 'mcpose/testing';
```

`createMockBackendClient()` returns an in-memory backend stub with capability lookup and notification hooks. It works with both `createProxyServer()` and `startHttpProxy()` tests.

---

## `@mcpose/audit`

```bash
npm install @mcpose/audit
```

`@mcpose/audit` provides a tamper-evident, compliance-grade audit trail for every tool call. It produces an HMAC-chained log of `AuditEvent` records and a `ReplayManifest` per session: a Merkle-proof document that lets auditors verify what happened without re-executing anything.

Detecting tampering requires the signing secret: `verifyAuditChain(events, signingKey)` recomputes every chain hash, and `verifyManifestSignature(manifest, signingKey)` checks the manifest signature.
The keyless assertions in [`@mcpose/testing`](#mcposetesting) prove internal consistency — reordering, renumbering, duplication, head or middle deletion, and a swapped Merkle root — but not authenticity: a self-consistent forgery with regenerated proofs passes, and tail truncation passes `assertAuditChainIntegrity` (the manifest's `eventCount` catches it). See the [@mcpose/testing README](#mcposetesting) for the limits of each assertion.

`@mcpose/audit` 3.0.0 writes audit format v2, a breaking format change: archives written by a 2.x release verify only with a pinned 2.x.
See [ADR-0004](./docs/adr/0004-audit-format-v2-canonical-serialization.md) for the canonical-serialization and full-manifest-signature rationale.

The audit layer never throws into the tool-call path: its own failures (event serialization, a throwing `onEvent` sink) are reported to the `onAuditError` hook instead.

### Sensitivity tiers

Every audit event is classified by a `SensitivityTier`:

| Tier | Stored fields |
|---|---|
| `'low'` | `inputRaw`, `outputRaw` (plaintext) |
| `'medium'` | `inputRaw`, `outputRaw` (PII already redacted upstream) |
| `'high'` | `inputEncrypted`, `outputEncrypted` (AES-256-GCM, per-event key) |

Unknown tools always resolve to `'high'`.

### Quick start

```ts
import { createAuditMiddleware, createDefaultSigningKeyProvider, createSensitivityResolver } from '@mcpose/audit';
import { startHttpProxy } from 'mcpose';

// Supplied by your application:
//   backend: an mcpose BackendClient (see Quick Start above)
//   auditLog: your durable sink for audit events
//   manifestStore: your durable sink for replay manifests
//   piiMW: an upstream redaction middleware
//   extractJwt: your resolveIdentity function

const signingKey = createDefaultSigningKeyProvider(process.env.AUDIT_SECRET!);

const sensitivityResolver = createSensitivityResolver({
  get_balance:    'low',
  search_trades:  'medium',
  transfer_funds: 'high',
});

const auditHandle = createAuditMiddleware({
  signingKey,
  sensitivityResolver,
  onEvent: (event) => auditLog.append(event),
  onManifest: (manifest) => manifestStore.save(manifest),
});

const server = await startHttpProxy(backend, {
  toolMiddleware: [piiMW, auditHandle.middleware],
}, {
  resolveIdentity: extractJwt,
  onSessionClosed: (sessionId) => auditHandle.closeSession(sessionId),
});
```

### `createSensitivityResolver(map, override?)`

```ts
const resolver = createSensitivityResolver(
  { get_balance: 'low', search: 'medium' },
  // Optional override fn: takes precedence over the static map.
  // The 4th argument is the map's resolution (already defaulted to 'high'
  // for unknown tools), so the override can fall back to it.
  (tool, identity, args, mapTier) =>
    identity.roles.includes('admin') ? 'low' : mapTier,
);
```

The override function type is exported as `SensitivityOverrideFn`.
Unknown tools not in the map always resolve to `'high'` unless the override fn returns otherwise.

### `createDefaultSigningKeyProvider(secret)`

```ts
const signingKey = createDefaultSigningKeyProvider('your-secret-or-buffer');
// { algorithm: 'HMAC-SHA256', keyId: '<sha256-of-secret>', sign(data) }
```

HMAC-SHA256 in-process signing. For production, implement `SigningKeyProvider` against your KMS.

### `createAuditMiddleware(options)`

```ts
interface AuditOptions {
  signingKey: SigningKeyProvider;
  sensitivityResolver: SensitivityResolverFn;
  onEvent: (event: AuditEvent) => void | Promise<void>;
  /**
   * Called with the finished ReplayManifest when closeSession() is invoked.
   *
   * Why this exists: ToolMiddleware is a pure per-request function with no
   * lifecycle hooks. Sessions are owned by the HTTP transport, not by
   * middleware. The host signals session end via closeSession(); onManifest
   * is the push-based delivery mechanism for the resulting manifest.
   */
  onManifest?: (manifest: ReplayManifest) => void | Promise<void>;
  /** Record events for rejected calls (hidden tools etc.). Default: true. */
  includeRejections?: boolean;
  /**
   * Called when the audit layer itself fails (event serialization, a
   * throwing onEvent sink). The audit layer NEVER throws into the
   * tool-call path. Default: console.error.
   */
  onAuditError?: (
    err: unknown,
    info: { tool: string; requestId: string; sessionId?: string },
  ) => void;
}

interface AuditMiddlewareHandle {
  middleware: ToolMiddleware;
  closeSession(sessionId: string): Promise<ReplayManifest | undefined>;
}
```

`closeSession` returns `undefined` if the session had no events or is unknown. Wire it to `HttpProxyOptions.onSessionClosed`.
The returned `middleware` is already marked as a pass-through observer, so tools listed in `passThroughTools` stay audited.

### `AuditEvent` schema

A discriminated union on `sensitivityTier`.
The base record every event shares (hashes, chain link, outcome, identity).

<details>
<summary>Show the <code>AuditEvent</code> schema</summary>

```ts
// Discriminated union on sensitivityTier
type AuditEvent = LowAuditEvent | MediumAuditEvent | HighAuditEvent;

interface AuditEventBase {
  id: string;                    // = ProxyContext.requestId
  startedAt: string;             // ISO timestamp captured before the upstream call started
  endedAt: string;               // ISO timestamp captured after the upstream call settled
  sessionId?: string;
  identity: Identity;
  delegatedFrom?: Identity[];
  tool: string;
  duration_ms: number;
  outcome: 'success' | 'rejected' | 'error';
  /** Present when outcome is 'rejected' (from the MCP error's data field). */
  rejectionReason?: RejectionReason;
  /** Present when outcome is 'error': what the upstream call threw. */
  error?: { name: string; message: string };
  inputHash: string;             // SHA-256
  outputHash: string;
  chainHash: string;             // HMAC(entry || prevChainHash)
  replayManifestPosition: number;
}
```

</details>

### `ReplayManifest`

Produced at session close.
Covers all audit events with a Merkle root and individual proofs, signed by the `SigningKeyProvider`.
The signature covers the canonical serialization of the entire manifest (every field, domain-separated), not just the Merkle root; verify it with `verifyManifestSignature(manifest, signingKey)`.
Any third party can verify a single event without access to the full log.

<details>
<summary>Show the <code>ReplayManifest</code> interface</summary>

```ts
interface ReplayManifest {
  sessionId: string;
  identity: Identity;
  startedAt: string;
  closedAt: string;
  eventCount: number;
  merkleRoot: string;
  merkleProofs: MerkleProof[];
  signedBy: string;   // keyId
  signature: string;  // HMAC over the canonical serialization of the ENTIRE manifest
}
```

</details>

### Verifiers and canonical serialization

`@mcpose/audit` exports the keyed verifiers and the canonical serialization helpers they build on:

| Export | Purpose |
|---|---|
| `verifyAuditChain(events, signingKey)` | Recomputes every event's `chainHash` with the chain key; reports the first bad index. An empty event list is invalid. |
| `verifyManifestSignature(manifest, signingKey)` | Constant-time check of the full-manifest signature. |
| `canonicalJson(value)` | Strict canonical JSON (keys sorted at every depth); the hash/signature preimage format. |
| `stableStringify(value)` | Total, key-order-independent serialization used for `inputHash`/`outputHash`. |

---

## `@mcpose/testing`

```bash
npm install --save-dev @mcpose/testing
```

Compliance assertion helpers for use in test suites:

```ts
import {
  assertAuditChainIntegrity,
  assertReplayManifestValid,
  assertPiiRedacted,
  assertDelegationHonored,
} from '@mcpose/testing';
```

| Function | What it checks |
|---|---|
| `assertAuditChainIntegrity(events)` | Sequential positions, non-empty and distinct chain hashes; throws on an empty chain (a log truncated to zero events must not pass) |
| `assertReplayManifestValid(events, manifest)` | Event count matches; the Merkle root recomputes from the events under test; one proof per event, each verifying at its own index |
| `assertPiiRedacted(event, patterns)` | Low/medium: no pattern matches the plaintext fields. High: the event is structurally encrypted (no plaintext `inputRaw`/`outputRaw` present, encrypted payloads present) |
| `assertDelegationHonored(event)` | The event's `delegatedFrom` chain is non-empty and every entry has a `sub` |

These assertions are deliberately keyless: the signing secret is not available to tests.
They prove the artifact is internally consistent: they catch reordering, renumbering, duplication, head or middle deletion, and a swapped Merkle root.
They do not prove it is authentic. A forger who rewrites every event and regenerates the root and proofs produces a document these assertions accept, and does not need the signing secret to do it. Deleting from the tail also leaves a valid prefix, so `assertAuditChainIntegrity` alone accepts it; `manifest.eventCount` is what catches that.
For keyed verification, use `verifyAuditChain(events, signingKey)` and `verifyManifestSignature(manifest, signingKey)` from `@mcpose/audit`.

---

## Recipe: PII redaction + audit

The origin use case for mcpose: a financial-grade MCP server where every Elasticsearch tool response must be scrubbed of PII before it reaches the LLM or the audit log.

```ts
import { hasToolContent } from 'mcpose';
import type { ToolMiddleware } from 'mcpose';
import { createAuditMiddleware, createDefaultSigningKeyProvider, createSensitivityResolver } from '@mcpose/audit';

function createPiiMiddleware(patterns: RegExp[]): ToolMiddleware {
  return async (req, next) => {
    const result = await next(req);
    if (!hasToolContent(result)) return result;
    return {
      ...result,
      content: result.content.map((item) =>
        item.type === 'text'
          ? { ...item, text: patterns.reduce((t, re) => t.replace(re, '[REDACTED]'), item.text) }
          : item,
      ),
    };
  };
}

const auditHandle = createAuditMiddleware({
  signingKey: createDefaultSigningKeyProvider(process.env.AUDIT_SECRET!),
  sensitivityResolver: createSensitivityResolver({ search: 'medium', transfer: 'high' }),
  onEvent: (e) => auditLog.append(e),
  onManifest: (m) => manifestStore.save(m),
});

await startHttpProxy(backend, {
  toolMiddleware: [
    createPiiMiddleware([/\b\d{9}\b/g, /[A-Z]{2}\d{6}/g]), // PII first
    auditHandle.middleware,                                   // audit sees clean data
  ],
}, {
  resolveIdentity: extractJwt,
  onSessionClosed: (id) => auditHandle.closeSession(id),
});
```

PII is redacted *before* the audit layer ever sees the response; no raw PII reaches a log.

> **Reference implementation:** [`elastic-pii-proxy`](https://github.com/amir-gorji/elastic-pii-proxy) is a production example of this pattern: an Elasticsearch MCP proxy that uses mcpose with PII redaction and `@mcpose/audit` to serve financial data safely to LLM agents.

---

## Recipe: list_tools rewriting

```ts
import type { ListToolsMiddleware } from 'mcpose';

const enrichDescriptions: ListToolsMiddleware = async (req, next, context) => {
  const result = await next(req);
  return {
    ...result,
    tools: result.tools.map((tool) =>
      tool.name === 'wire_transfer'
        ? { ...tool, description: `${tool.description ?? ''} (approval required)` }
        : tool,
    ),
  };
};
```

`hiddenTools` remains authoritative even if a `listToolsMiddleware` tries to re-add a hidden tool.

---

## Examples

Runnable, well-commented examples live in [`examples/`](./examples/).

| File | What it shows |
|---|---|
| [`pii-redaction-audit.ts`](./examples/pii-redaction-audit.ts) | The canonical mcpose pattern: PII redaction composed with audit middleware over HTTP/SSE, with per-session identity resolution. |
| [`governance-proxy.ts`](./examples/governance-proxy.ts) | Governance features: `hiddenTools`, `passThroughTools`, and `onTelemetry`. Self-contained, uses `createMockBackendClient` so no upstream server is needed. |
| [`oauth-upstream-client.ts`](./examples/oauth-upstream-client.ts) | Connecting to an OAuth-protected remote MCP server from Node: dynamic client registration, PKCE, browser authorization, and persisted tokens with automatic refresh. |

The examples resolve the workspace packages directly, so they run against your checkout:

```bash
# From the repository root:
pnpm install
pnpm --filter mcpose-examples governance-proxy        # governance (self-contained, no upstream needed)
pnpm --filter mcpose-examples pii-redaction-audit     # PII redaction + audit (needs an upstream MCP server)
pnpm --filter mcpose-examples oauth-upstream-client   # OAuth against a remote MCP server
```

The comments in each file walk through the setup step by step and mark the values you need to supply: upstream endpoint, audit secret, identity resolver, and durable sinks.

---

## Roadmap

- [x] Composable middleware: `startProxy()`, `startHttpProxy()`, `createProxyServer()`
- [x] Streamable HTTP transport with stateful sessions and SSE reconnect replay
- [x] Identity resolution: `resolveIdentity` hook, `Identity` on `ProxyContext`
- [x] mTLS support: `tlsOptions` on `HttpProxyOptions`
- [x] `@mcpose/audit`: HMAC chain, Merkle proofs, `ReplayManifest`, sensitivity tiers
- [x] `@mcpose/testing`: compliance assertion helpers
- [ ] `@mcpose/policy`: RBAC policy engine (v3)
- [ ] `@mcpose/fintech-identity`: OIDC → financial identity profile (v3)
- [ ] `@mcpose/otel`: OpenTelemetry spans adapter (v3)
- [ ] Persistent EventStore adapters: Redis, Postgres (v3)
- [ ] GDPR/CCPA consent middleware + cryptographic erasure (v3)

---

## Contributing

Contributions are welcome.
See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the development setup, the common `pnpm` commands, and the project conventions around `CONTEXT.md` and the ADRs.

A few load-bearing rules:

- The `@mcpose/audit` tamper-evidence invariants must never silently break.
  Read [ADR-0003](./docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md) and [ADR-0004](./docs/adr/0004-audit-format-v2-canonical-serialization.md) before touching the chain, signing, encryption, or `ReplayManifest`.
- Run `pnpm ts:ci` and `pnpm test` before opening a pull request.
- Do not weaken an existing audit assertion to make a test pass.

By participating you agree to uphold the [Code of Conduct](./CODE_OF_CONDUCT.md).

To report a security vulnerability, follow [`SECURITY.md`](./SECURITY.md) and report it privately.
Do not open a public issue for security reports.

---

## License

MIT
