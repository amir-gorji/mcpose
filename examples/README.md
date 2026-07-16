# mcpose examples

Runnable examples demonstrating the core mcpose patterns.
Each example is a self-contained TypeScript file.

## Running an example

From the repository root, install dependencies and run with `tsx`:

```bash
# Install workspace dependencies (repo root)
pnpm install

# Run an example (from the examples/ directory)
cd examples
pnpm exec tsx governance-proxy.ts       # governance (self-contained, no upstream needed)
pnpm exec tsx pii-redaction-audit.ts    # PII redaction + audit (needs an upstream MCP server)
```

Each example expects a few things supplied by your application: an upstream MCP server endpoint, an identity resolver, and durable sinks for audit events and manifests.
The `pii-redaction-audit.ts` example needs an upstream MCP server; `governance-proxy.ts` uses `createMockBackendClient` and runs with zero external dependencies.
The comments in each file mark these clearly.

## Examples

| File | What it shows |
|---|---|
| [`pii-redaction-audit.ts`](./pii-redaction-audit.ts) | The canonical mcpose pattern: PII redaction middleware composed with audit middleware, served over HTTP/SSE with per-session identity resolution. This is the origin use case for mcpose. Requires an upstream MCP server. |
| [`governance-proxy.ts`](./governance-proxy.ts) | Governance features: `hiddenTools`, `passThroughTools`, and `onTelemetry`. Uses `createMockBackendClient` so it runs with zero external dependencies. No upstream server needed. |

## Reference implementation

[`elastic-pii-proxy`](https://github.com/amir-gorji/elastic-pii-proxy) is a production example of the PII redaction + audit pattern: an Elasticsearch MCP proxy that uses mcpose to serve financial data safely to LLM agents.
