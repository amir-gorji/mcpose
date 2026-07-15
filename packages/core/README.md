# mcpose

[![npm](https://img.shields.io/npm/v/mcpose)](https://www.npmjs.com/package/mcpose)
[![license](https://img.shields.io/npm/l/mcpose)](https://github.com/amir-gorji/mcpose/blob/main/LICENSE)

**The composable middleware proxy for MCP.**

mcpose sits between a **client** (an LLM or agent) and an **upstream** MCP server, forwarding every tool, resource, and `list_tools` call through a **pipeline** of composable middleware. It is a transparent proxy: the client talks to mcpose exactly as it would talk to the upstream, while you intercept, transform, hide, or govern calls in between — without touching the upstream server.

## When to reach for it

- Add cross-cutting behavior (logging, PII redaction, identity resolution, rate limiting) to an MCP server you don't own.
- Hide or gate specific tools/resources per caller.
- Resolve a caller **identity** once per session and stamp it on every request.
- Lay the foundation for compliance-grade audit trails with [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit).

If you only need the audit chain or the compliance test helpers, see the ecosystem packages below — they build on this core.

## Install

```bash
npm install mcpose
```

Requires Node.js 18+. Ships ESM with TypeScript types.

## Quick start

Connect to an upstream over stdio, add one middleware, and serve the proxy:

```ts
import { createBackendClient, startProxy } from 'mcpose';
import type { ToolMiddleware } from 'mcpose';

// 1. Connect to the upstream MCP server (stdio)
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

// 3. Start the proxy on stdio
await startProxy(backend, {
  toolMiddleware: [loggingMW],
});
```

To serve over HTTP instead — with identity resolution, mTLS, session limits, and SSE reconnect replay — use `startHttpProxy`:

```ts
import { createBackendClient, startHttpProxy } from 'mcpose';

// Supplied by your application:
//   extractJwt — a resolveIdentity function returning an Identity from the request
const backend = await createBackendClient({ url: 'http://localhost:9000/mcp' });

await startHttpProxy(
  backend,
  { toolMiddleware: [loggingMW] },
  {
    port: 3000,
    resolveIdentity: extractJwt, // stamped on every ProxyContext in the session
    onSessionClosed: (sessionId) => {/* flush audit manifest, etc. */},
  },
);
```

## Core concepts

- **Middleware** — a single function `(req, next, ctx) => Promise<result>`. Call `next(req)` to delegate downstream; transform the request before, or the response after. Middlewares nest onion-style.
- **Pipeline** — middlewares passed to `ProxyOptions` run in response-processing order (first = innermost). `[piiMW, auditMW]` redacts before it audits.
- **ProxyContext** — per-request metadata threaded through the pipeline: `requestId`, `transport`, `sessionId`, resolved `identity`, and the agent `delegatedFrom` chain.

## API surface

| Export | Purpose |
|---|---|
| `createBackendClient(config)` | Connect to an upstream over stdio (`command`/`args`) or HTTP (`url`). |
| `startProxy(backend, options?)` | Serve the proxy over **stdio**. |
| `startHttpProxy(backend, proxyOptions?, httpOptions?)` | Serve over **HTTP/SSE** — identity, mTLS, sessions, reconnect replay. |
| `createProxyServer(backend, options?)` | Build the underlying `Server` without binding a transport. |
| `compose(middlewares)` | Compose middlewares into one (outermost-first). |
| `createProxyContext(overrides?)` | Construct a `ProxyContext` (useful in tests). |
| `createInMemoryEventStore()` | Default SSE reconnect event store; swap for a `PersistentEventStore`. |
| `hasToolContent(result)` | Type guard for tool-call results. |

**Key types:** `Middleware<Req, Res>`, `ToolMiddleware`, `ResourceMiddleware`, `ListToolsMiddleware`, `ProxyContext`, `Identity`, `BackendConfig`, `ProxyOptions`, `HttpProxyOptions`, `RejectionReason`, `TelemetryEvent`, `PersistentEventStore`.

### Backend config (`BackendConfig`)

`createBackendClient` accepts a `BackendConfig` describing how to reach the upstream, in one of two modes.

| Field | Mode | Description |
|---|---|---|
| `command` | stdio | Shell command to spawn the backend (e.g. `"node"`). |
| `args` | stdio | Args passed to `command` (e.g. `["/path/to/server.mjs"]`). |
| `url` | HTTP/SSE | URL of a running backend. Takes precedence over stdio. |
| `headers` | HTTP/SSE | Custom HTTP headers sent on every request to the backend. |

`headers` is HTTP/SSE only and is ignored in stdio mode.
Use it to authenticate with the upstream, for example an API key or bearer token.

```ts
const backend = await createBackendClient({
  url: 'https://mcp.example.com/sse',
  headers: { Authorization: `Bearer ${process.env.UPSTREAM_TOKEN}` },
});
```

### Governance options (`ProxyOptions`)

`hiddenTools` / `hiddenResources` reject calls with a structured [`RejectionReason`](https://github.com/amir-gorji/mcpose#rejectionreason) in the MCP error `data` field; `passThroughTools` skip the pipeline entirely; `onTelemetry` emits per-call timing and outcome.

### Test helpers — `mcpose/testing`

The core package exposes proxy/middleware test utilities under a subpath:

```ts
import { createMockBackendClient, runToolMiddleware } from 'mcpose/testing';
```

> **Not to be confused with** [`@mcpose/testing`](https://www.npmjs.com/package/@mcpose/testing), the separate package of compliance-chain assertions.

## The mcpose ecosystem

| Package | What it adds |
|---|---|
| **`mcpose`** (this package) | Proxy core — pipeline, transports, identity, governance. |
| [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit) | Tamper-evident, HMAC-chained audit events + Merkle `ReplayManifest`. |
| [`@mcpose/testing`](https://www.npmjs.com/package/@mcpose/testing) | Runner-agnostic compliance assertions for the audit chain. |

## Documentation

- [Full README & API reference](https://github.com/amir-gorji/mcpose#readme)
- [CONTEXT.md](https://github.com/amir-gorji/mcpose/blob/main/CONTEXT.md) — canonical domain glossary
- [Architecture decision records](https://github.com/amir-gorji/mcpose/tree/main/docs/adr)

## License

MIT © Amir Gorji
