# mcpose examples

Runnable, self-contained examples of the core mcpose patterns.
Each is one TypeScript file with a header comment stating its goal, architecture, prerequisites, and run command.

Every example resolves `mcpose` and `@mcpose/audit` from the workspace, so it always exercises the local source, and `pnpm turbo ts:ci` type-checks all of them in CI.

## Start here

`governance-proxy` is the one to run first: it uses `createMockBackendClient`, so it needs no upstream server and no secrets.

```bash
# From the repository root:
pnpm install
pnpm --filter mcpose-examples governance-proxy
```

## The examples

| Example | Type | What it shows | Prerequisites |
|---|---|---|---|
| [`governance-proxy.ts`](./governance-proxy.ts) | Feature demo | `hiddenTools`, `passThroughTools`, and `onTelemetry`. Covers all three routing paths in one file, because they are conceptually one feature. | None. Fully self-contained. |
| [`pii-redaction-audit.ts`](./pii-redaction-audit.ts) | Canonical use case | The pattern mcpose was built for: PII redaction composed with audit middleware over HTTP/SSE, with per-session identity resolution. | An upstream MCP server, an audit secret, an identity resolver, and durable sinks. |
| [`oauth-upstream-client.ts`](./oauth-upstream-client.ts) | Integration recipe | Connecting to an OAuth-protected upstream via `BackendConfig.authProvider`: dynamic client registration, PKCE, browser authorization, and persisted tokens with automatic refresh. | An OAuth-capable upstream MCP server. |

Run any of them from the repository root:

```bash
pnpm --filter mcpose-examples governance-proxy        # no upstream needed
pnpm --filter mcpose-examples pii-redaction-audit     # needs an upstream MCP server
pnpm --filter mcpose-examples oauth-upstream-client   # needs an OAuth-capable upstream
```

## What you have to supply

The two examples that talk to a real upstream expect values only you can provide: an upstream endpoint, an audit secret, an identity resolver, and durable sinks for audit events and manifests.
Each is marked with a loud comment at the point of use, so nothing is left to guess.

None of the examples hardcode a real secret.
`pii-redaction-audit.ts` reads `AUDIT_SECRET` and `UPSTREAM_URL` from the environment, falling back to obvious development placeholders so the file runs unconfigured.
Set `AUDIT_SECRET` to a high-entropy value (32+ random bytes) before the pattern means anything: the derived `keyId` is published in every replay manifest, so a guessable secret is offline-attackable.

## Reference implementation

[`elastic-pii-proxy`](https://github.com/amir-gorji/elastic-pii-proxy) runs the PII redaction and audit pattern in production: an Elasticsearch MCP proxy that uses mcpose to serve financial data safely to LLM agents.

It is a reference implementation rather than an example, so read it once the files here make sense, not before.
