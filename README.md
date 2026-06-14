<p align="center">
  <img src="assets/logo.png" alt="mcpose logo" width="500" />
</p>

# mcpose

[![npm](https://img.shields.io/npm/v/mcpose)](https://www.npmjs.com/package/mcpose)
[![license](https://img.shields.io/npm/l/mcpose)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/amir-gorji/mcpose/actions/workflows/deploy.yml/badge.svg)](https://github.com/amir-gorji/mcpose/actions/workflows/deploy.yml)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-025E8C?logo=dependabot)](https://github.com/amir-gorji/mcpose/blob/main/.github/dependabot.yml)

The audit and governance layer for MCP.

mcpose is a transparent middleware proxy for MCP servers. It intercepts, transforms, and governs tool calls through composable functional middleware — and with `@mcpose/audit`, produces tamper-evident, compliance-grade audit trails that satisfy DORA Article 17 and SR 11-7 requirements.

---

## New in 2.0

- **`@mcpose/audit`** — HMAC-chained audit events, Merkle-proof `ReplayManifest`, AES-256-GCM encryption for high-sensitivity tiers, `createSensitivityResolver`, `createDefaultSigningKeyProvider`
- **`@mcpose/testing`** — compliance assertion helpers: `assertAuditChainIntegrity`, `assertReplayManifestValid`, `assertPiiRedacted`, `assertDelegationHonored`
- **Identity resolution** — `resolveIdentity` hook on `HttpProxyOptions`; resolved `Identity` stamped on every `ProxyContext`
- **Agent delegation chain** — `delegatedFrom?: Identity[]` on `ProxyContext` for A2A handoff recording
- **mTLS** — pass `tlsOptions` to `startHttpProxy` for mutual TLS
- **SSE reconnect replay** — built-in in-memory `EventStore` with `PersistentEventStore` interface for Redis/Postgres adapters
- **Session lifecycle hook** — `onSessionClosed` on `HttpProxyOptions`; wire `auditHandle.closeSession` here to flush `ReplayManifest` on session end
- **Structured rejection reasons** — `RejectionReason` in MCP error `data` field on every blocked call

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
| [`mcpose`](./packages/core/README.md) | [![npm](https://img.shields.io/npm/v/mcpose)](https://www.npmjs.com/package/mcpose) | Proxy core — pipeline, transports, identity, governance. |
| [`@mcpose/audit`](./packages/audit/README.md) | [![npm](https://img.shields.io/npm/v/@mcpose/audit)](https://www.npmjs.com/package/@mcpose/audit) | Tamper-evident HMAC audit chain + Merkle `ReplayManifest`. |
| [`@mcpose/testing`](./packages/testing/README.md) | [![npm](https://img.shields.io/npm/v/@mcpose/testing)](https://www.npmjs.com/package/@mcpose/testing) | Runner-agnostic compliance assertions for the audit chain. |

---

## Install

```bash
npm install mcpose
```

**Peer dependency** — must be installed separately:

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
| **Pass-through** | `passThroughTools` / `passThroughResources` | Forwarded raw to upstream — all middleware skipped |
| **Middleware** | everything else | Routed through the full `toolMiddleware` / `resourceMiddleware` pipeline |

Prompts are forwarded as-is when the upstream supports prompts.

The proxy preserves core request semantics end to end:

- advertised capabilities are mirrored from the upstream server
- abort signals are forwarded to upstream tool, resource, and prompt calls
- upstream progress updates are relayed back to the downstream client
- list-changed notifications are advertised and fanned out when the upstream supports them
- `list_tools` responses can be transformed through `listToolsMiddleware` without weakening local `hiddenTools` guarantees

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

`compose([outerMW, innerMW])` uses the **opposite** (outermost-first) convention — `ProxyOptions` arrays are **not** interchangeable with `compose()` arguments.

---

## API Reference

### `ProxyContext` · `Middleware<Req, Res>` · `ToolMiddleware` · `ResourceMiddleware` · `ListToolsMiddleware` · `compose()` · `createProxyContext()`

```ts
interface ProxyContext {
  requestId: string;
  transport: 'stdio' | 'http';
  sessionId?: string;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** Resolved caller identity. Present when resolveIdentity is configured. */
  identity?: Identity;
  /** Agent delegation chain — populated from A2A handoff headers. */
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

// Type guard — narrows CompatibilityCallToolResult to CallToolResult
function hasToolContent(r: CompatibilityCallToolResult): r is CallToolResult;
```

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

```ts
interface ProxyOptions {
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

`onTelemetry` fires after every tool call with timing, outcome, tool name, and identity. Wire it to `@mcpose/otel` or any custom sink.

---

### `HttpProxyOptions` · `startHttpProxy()`

```ts
interface HttpProxyOptions {
  port?: number;         // Default: 3000
  host?: string;         // Default: all interfaces
  path?: string;         // Default: '/mcp'
  onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean | Promise<boolean>;
  onError?: (err: unknown) => void;
  maxBodyBytes?: number; // Default: 4 MB — returns 413 on excess
  maxSessions?: number;  // Excess requests return 503
  sessionTtlMs?: number; // Sessions auto-close after this duration
  /** Resolves caller identity once per session. Errors abort the session with 401. */
  resolveIdentity?: (req: http.IncomingMessage) => Identity | Promise<Identity>;
  /** mTLS — pass Node's https.ServerOptions (key, cert, ca, requestCert, rejectUnauthorized). */
  tlsOptions?: https.ServerOptions;
  /** SSE reconnect replay store. Defaults to in-memory. Pass null to disable. */
  eventStore?: PersistentEventStore | null;
  /** Called when a session closes. Wire auditHandle.closeSession here to flush ReplayManifest. */
  onSessionClosed?: (sessionId: string) => void;
}

function startHttpProxy(
  backend: BackendClient,
  options?: ProxyOptions,
  httpOptions?: HttpProxyOptions,
): Promise<http.Server>;
```

```ts
import { createBackendClient, startHttpProxy } from 'mcpose';

const backend = await createBackendClient({ url: 'http://upstream-mcp-server/mcp' });
const server = await startHttpProxy(backend, { toolMiddleware: [loggingMW] }, { port: 8080 });
```

On shutdown, active proxy sessions are closed before the underlying `http.Server` finishes closing.

---

### `RejectionReason`

Every blocked call embeds a `RejectionReason` in the MCP error `data` field. The top-level error code is unchanged, so existing clients that only inspect the code are unaffected. Audit middleware and agents can inspect `error.data.rejectionReason` for programmatic handling.

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

`@mcpose/audit` provides a tamper-evident, compliance-grade audit trail for every tool call. It produces an HMAC-chained log of `AuditEvent` records and a `ReplayManifest` per session — a Merkle-proof document that lets auditors verify what happened without re-executing anything.

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
//   backend       — an mcpose BackendClient (see Quick Start above)
//   auditLog      — your durable sink for audit events
//   manifestStore — your durable sink for replay manifests
//   piiMW         — an upstream redaction middleware
//   extractJwt    — your resolveIdentity function

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
  // Optional override fn — takes precedence over the static map
  (tool, identity, args) => identity.roles.includes('admin') ? 'low' : 'high',
);
```

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
  hashAlgorithm?: 'SHA-256';           // default: SHA-256
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
  includeRejections?: boolean;         // default: true
  includeCost?: boolean;               // default: true
}

interface AuditMiddlewareHandle {
  middleware: ToolMiddleware;
  closeSession(sessionId: string): Promise<ReplayManifest | undefined>;
}
```

`closeSession` returns `undefined` if the session had no events or is unknown. Wire it to `HttpProxyOptions.onSessionClosed`.

### `AuditEvent` schema

```ts
// Discriminated union on sensitivityTier
type AuditEvent = LowAuditEvent | MediumAuditEvent | HighAuditEvent;

interface AuditEventBase {
  id: string;                    // = ProxyContext.requestId
  timestamp: string;             // ISO 8601 microsecond
  sessionId?: string;
  identity: Identity;
  delegatedFrom?: Identity[];
  tool: string;
  duration_ms: number;
  outcome: 'success' | 'rejected' | 'error';
  rejectionReason?: RejectionReason;
  inputHash: string;             // SHA-256
  outputHash: string;
  chainHash: string;             // HMAC(entry || prevChainHash)
  replayManifestPosition: number;
}
```

### `ReplayManifest`

Produced at session close. Covers all audit events with a Merkle root and individual proofs, signed by the `SigningKeyProvider`. Any third party can verify a single event without access to the full log.

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
  signature: string;  // signs merkleRoot
}
```

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
| `assertAuditChainIntegrity(events)` | Sequential positions, non-empty chain hashes, no duplicates (tamper detection) |
| `assertReplayManifestValid(events, manifest)` | Event count matches; Merkle proof verifies for every event |
| `assertPiiRedacted(event, patterns)` | No pattern matches in plaintext fields; passes automatically for high-tier (encrypted) events |
| `assertDelegationHonored(chain)` | Non-empty chain; every entry has a `sub` |

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

PII is redacted *before* the audit layer ever sees the response — no raw PII reaches a log.

> **Reference implementation:** [`elastic-pii-proxy`](https://github.com/amir-gorji/elastic-pii-proxy) is a production example of this pattern — an Elasticsearch MCP proxy that uses mcpose with PII redaction and `@mcpose/audit` to serve financial data safely to LLM agents.

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

## Roadmap

- [x] Composable middleware — `startProxy()`, `startHttpProxy()`, `createProxyServer()`
- [x] Streamable HTTP transport with stateful sessions and SSE reconnect replay
- [x] Identity resolution — `resolveIdentity` hook, `Identity` on `ProxyContext`
- [x] mTLS support — `tlsOptions` on `HttpProxyOptions`
- [x] `@mcpose/audit` — HMAC chain, Merkle proofs, `ReplayManifest`, sensitivity tiers
- [x] `@mcpose/testing` — compliance assertion helpers
- [ ] `@mcpose/policy` — RBAC policy engine (v3)
- [ ] `@mcpose/fintech-identity` — OIDC → financial identity profile (v3)
- [ ] `@mcpose/otel` — OpenTelemetry spans adapter (v3)
- [ ] Persistent EventStore adapters — Redis, Postgres (v3)
- [ ] GDPR/CCPA consent middleware + cryptographic erasure (v3)

---

## License

MIT
