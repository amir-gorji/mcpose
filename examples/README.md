# mcpose examples

Runnable examples demonstrating the core mcpose patterns.
Each example is a self-contained TypeScript file.

## Running an example

From the repository root, install dependencies and run with `tsx`:

```bash
# Install workspace dependencies (repo root)
pnpm install

# Run an example (from the repo root)
pnpm --filter mcpose-examples governance-proxy        # governance (self-contained, no upstream needed)
pnpm --filter mcpose-examples pii-redaction-audit     # PII redaction + audit (needs an upstream MCP server)
pnpm --filter mcpose-examples oauth-upstream-client   # OAuth-authenticated upstream backend
```

The examples resolve `mcpose` and `@mcpose/audit` from the workspace, so they always exercise the local source, and `pnpm turbo ts:ci` type-checks them in CI.

Each example expects a few things supplied by your application: an upstream MCP server endpoint, an identity resolver, and durable sinks for audit events and manifests.
The `pii-redaction-audit.ts` example needs an upstream MCP server; `governance-proxy.ts` uses `createMockBackendClient` and runs with zero external dependencies.
The comments in each file mark these clearly.

## Examples

| File | What it shows |
|---|---|
| [`pii-redaction-audit.ts`](./pii-redaction-audit.ts) | The canonical mcpose pattern: PII redaction middleware composed with audit middleware, served over HTTP/SSE with per-session identity resolution. This is the origin use case for mcpose. Requires an upstream MCP server. |
| [`governance-proxy.ts`](./governance-proxy.ts) | Governance features: `hiddenTools`, `passThroughTools`, and `onTelemetry`. Uses `createMockBackendClient` so it runs with zero external dependencies. No upstream server needed. |
| [`oauth-upstream-client.ts`](./oauth-upstream-client.ts) | Connecting the proxy to an OAuth-protected upstream via `BackendConfig.authProvider`. Requires an OAuth-capable upstream MCP server. |

## Reference implementation

[`elastic-pii-proxy`](https://github.com/amir-gorji/elastic-pii-proxy) is a production example of the PII redaction + audit pattern: an Elasticsearch MCP proxy that uses mcpose to serve financial data safely to LLM agents.
