# mcpose

Composable middleware proxy for MCP servers.

---

## Background

mcpose was extracted from [`financial-elastic-mcp-server`](https://github.com/amir-gorji/financial-elastic-mcp-server), an Elasticsearch MCP server built for financial institutions that needed PII redaction and audit logging on every tool call. Those cross-cutting concerns were originally hardcoded into a single server. mcpose lifts that pattern into a reusable, composable middleware layer that can wrap **any** upstream MCP server.

---

## Concept

mcpose is a **transparent proxy**: it sits between an LLM client and an upstream MCP server, mirroring the upstream's tool, resource, and prompt lists while routing all calls through a configurable middleware pipeline. The client sees a normal MCP server; the upstream sees a normal MCP client. mcpose is the layer in between — controlling visibility and applying transformations without either side knowing.

---

## Install

```bash
npm install mcpose
```

**Peer dependency** — must be installed separately:

```bash
npm install @modelcontextprotocol/sdk@>=1.0.0
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
│  (Claude,    │        │  · visibility filters          │        │  server            │
│   Cursor…)   │        │  · middleware pipelines        │        │  (stdio or HTTP)   │
└──────────────┘        └────────────────────────────────┘        └────────────────────┘
```

For each tool or resource, mcpose picks one of three routing paths:

| Path | Option | Behavior |
|---|---|---|
| **Hidden** | `hiddenTools` / `hiddenResources` | Omitted from list responses; rejected with an error at call time |
| **Pass-through** | `passThroughTools` / `passThroughResources` | Forwarded raw to upstream — all middleware skipped |
| **Middleware** | everything else | Routed through the full `toolMiddleware` / `resourceMiddleware` pipeline |

Prompts are always forwarded as-is — no filtering or middleware.

---

## Middleware model

Middleware follows the **onion model**: outer layers run code before *and* after inner layers. Each middleware receives the request and a `next` function to invoke the rest of the pipeline.

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

**Array order in `ProxyOptions`** uses **response-processing order**: the first element processes the response *first* (innermost layer). `ProxyOptions` calls `pipe()` internally — no need to wrap manually. To guarantee audit never sees raw PII:

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

A middleware can **short-circuit** by returning without calling `next`, or **handle upstream errors** by wrapping `await next(req)` in a try/catch.

---

## API Reference

### `Middleware<Req, Res>` · `ToolMiddleware` · `ResourceMiddleware` · `compose()`

```ts
type Middleware<Req, Res> = (
  req: Req,
  next: (req: Req) => Promise<Res>,
) => Promise<Res>;

// Convenience aliases for the two pipeline types:
type ToolMiddleware     = Middleware<CallToolRequest, CompatibilityCallToolResult>;
type ResourceMiddleware = Middleware<ReadResourceRequest, ReadResourceResult>;

function compose<Req, Res>(
  middlewares: ReadonlyArray<Middleware<Req, Res>>,
): Middleware<Req, Res>;

// Type guard — narrows CompatibilityCallToolResult to CallToolResult
// (safe access to .content and .isError without casts):
function hasToolContent(r: CompatibilityCallToolResult): r is CallToolResult;
```

`compose` takes an array in **outermost-first** order. Use `hasToolContent` in middleware implementations before accessing `.content` or `.isError`, since `CompatibilityCallToolResult` also covers the legacy `{ toolResult }` shape.

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

`BackendClient` is an alias for the SDK `Client`. Throws if neither `command` nor `url` is provided, or if the connection fails.

---

### `ProxyOptions` · `startProxy()` · `createProxyServer()`

```ts
interface ProxyOptions {
  toolMiddleware?:       ReadonlyArray<ToolMiddleware>;
  resourceMiddleware?:   ReadonlyArray<ResourceMiddleware>;
  passThroughTools?:     ReadonlyArray<string>;
  passThroughResources?: ReadonlyArray<string>;
  hiddenTools?:          ReadonlyArray<string>;
  hiddenResources?:      ReadonlyArray<string>;
}

async function startProxy(backend: BackendClient, options?: ProxyOptions): Promise<void>;
function createProxyServer(backend: BackendClient, options?: ProxyOptions): Server;
```

| Option | Description |
|---|---|
| `toolMiddleware` | Middleware stack for tool calls, in response-processing order (first element processes response first). |
| `resourceMiddleware` | Middleware stack for resource reads, in response-processing order. |
| `passThroughTools` | Tool names forwarded raw to upstream — middleware skipped entirely. |
| `passThroughResources` | Resource URIs forwarded raw to upstream — middleware skipped entirely. |
| `hiddenTools` | Tool names removed from `list_tools` **and** rejected at call time with `MethodNotFound`. |
| `hiddenResources` | Resource URIs removed from `list_resources` **and** rejected at call time with `InvalidRequest`. |

`startProxy` connects the proxy to a `StdioServerTransport`. `createProxyServer` returns the configured `Server` without connecting — useful for testing request handlers without a live transport.

---

### `HttpProxyOptions` · `startHttpProxy()`

```ts
interface HttpProxyOptions {
  port?: number; // Default: 3000
  host?: string; // Default: all interfaces
  path?: string; // Default: '/mcp'
}

function startHttpProxy(
  backend: BackendClient,
  options?: ProxyOptions,
  httpOptions?: HttpProxyOptions,
): Promise<http.Server>;
```

Starts the proxy over Streamable HTTP with stateful sessions. Each client connection is assigned an `mcp-session-id`; upstream list-change notifications (`tools/list_changed`, `resources/list_changed`, `prompts/list_changed`) are fanned out to all active sessions.

```ts
import { createBackendClient, startHttpProxy } from 'mcpose';

const backend = await createBackendClient({ url: 'http://upstream-mcp-server/mcp' });
const server = await startHttpProxy(backend, { toolMiddleware: [loggingMW] }, { port: 8080 });
// HTTP server is now listening on port 8080 at /mcp
```

**Limitations:**
- Two `startHttpProxy` calls sharing the same `backend` will overwrite each other's notification handlers (last call wins).
- Sessions are only cleaned up on `DELETE` or server close — there is no idle timeout.
- SSE reconnect replay is not supported (no `EventStore`).

---

## Recipe: PII redaction

The origin use case for mcpose: a financial-grade MCP server where every Elasticsearch tool response must be scrubbed of PII before it reaches the LLM or the audit log.

Use a factory to keep middleware configurable and testable:

```ts
import { hasToolContent } from 'mcpose';
import type { ToolMiddleware } from 'mcpose';

function createPiiMiddleware(patterns: RegExp[]): ToolMiddleware {
  return async (req, next) => {
    const result = await next(req);
    if (!hasToolContent(result)) return result;
    return {
      ...result,
      content: result.content.map((item) =>
        item.type === 'text'
          ? { ...item, text: redactPii(item.text, patterns) }
          : item,
      ),
    };
  };
}

function redactPii(text: string, patterns: RegExp[]): string {
  return patterns.reduce((t, re) => t.replace(re, '[REDACTED]'), text);
}
```

Stack it with audit middleware — PII first in the array so audit always sees clean data:

```ts
await startProxy(backend, {
  toolMiddleware: [
    createPiiMiddleware([/\b\d{9}\b/g, /[A-Z]{2}\d{6}/g]), // SSNs, account numbers
    createAuditMiddleware({ destination: auditLog }),
  ],
});
```

The array order guarantees: PII is redacted *before* the audit layer ever sees the response. No raw PII reaches a log, satisfying financial regulatory requirements.

> **Reference implementation:** [`elastic-pii-proxy`](https://github.com/amir-gorji/elastic-pii-proxy) is a production example of this pattern — an Elasticsearch MCP proxy that uses mcpose with a PII redaction middleware and an audit middleware to serve financial data safely to LLM agents.

---

## Roadmap

- [x] **HTTP/SSE server transport** — `startHttpProxy()` adds a Streamable HTTP server-side transport with stateful sessions
- [ ] **ATXP protocol support** — enable MCP monetization by implementing the ATXP (Agent Transaction Protocol) standard, letting tool providers attach pricing and billing metadata to responses

---

## License

MIT
