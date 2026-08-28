# mcpose

A composable middleware proxy for MCP servers, plus a suite of compliance packages targeting financial institutions subject to audit and governance requirements.

## Language

### Topology

**Client**: The LLM or agent making requests to mcpose. _Avoid_: "downstream", "caller"

**Upstream**: The MCP server mcpose forwards calls to. _Avoid_: "backend server", "target server"

**Proxy**: mcpose's role between a client and an upstream. _Avoid_: "middleware layer"

**Mesh**: A proxy configured with a record of named upstreams instead of one, serving all of them through a single pipeline, session, and audit trail. The single-upstream shape stays a 1:1 proxy (ADR-0013). _Avoid_: "cluster", "federation", "multiplexer"

**Backend key**: The record key naming one upstream of a mesh. Non-empty, never contains `__`, and forms the `<backendKey>__<name>` prefix the client sees. Part of the proxy's public contract: renaming one renames every tool. _Avoid_: "backend id", "namespace" for the key itself

**Namespaced name**: The name a mesh exposes for an upstream tool or prompt, `<backendKey>__<name>`. Every `ProxyOptions` predicate, list, and middleware sees this name, never the upstream one. _Avoid_: "prefixed name", "qualified name"

**mcpose**: The core proxy library — pipeline, transport adapters, ProxyContext. Published as `mcpose` on npm (`packages/core`). _Avoid_: using to mean the full ecosystem

**mcpose ecosystem**: The full suite — `mcpose` core plus `@mcpose/audit`, `@mcpose/testing`, and future packages (`@mcpose/otel` is planned for v3; it does not exist yet).

### Middleware

**Middleware**: A single composable function `(req, next, ctx) => Promise<result>`. Concrete types: `ToolMiddleware`, `ListToolsMiddleware`, `ResourceMiddleware`. _Avoid_: using to mean the proxy itself

**Pipeline**: A composed chain of middleware functions. _Avoid_: "middleware stack", "middleware chain"

### Identity and delegation

**Identity**: Who made a request. The `Identity` interface: `sub`, `type` (`human` | `agent` | `service`), `roles`, `claims`, `source`. _Avoid_: "caller", "user", "principal"

**Identity resolution**: The act of producing an `Identity` from a raw request, via the `resolveIdentity` hook. _Avoid_: "auth", "authentication"

**Delegation**: A single link in an agent-to-agent handoff — one `Identity` in the `delegatedFrom` array.

**Delegation chain**: The full sequence of agents that handed off the request before reaching mcpose. `delegatedFrom?: Identity[]` on `ProxyContext`. Core does not populate it yet (no delegation header spec until v3); it is stamped on audit events only when the host places it on the context. _Avoid_: "agent chain", "call chain"

**Proxy identity**: Which proxy instance handled a request — `proxy?: ProxyIdentity` (`{ name, version }`) on `ProxyContext`, stamped by `createProxyServer` from `ProxyOptions` with defaults applied. Provenance, not a principal: never an entry in `delegatedFrom`, and no part of the caller-attribution model (ADR-0012). _Avoid_: "server identity", "instance id"

### Sessions

**Session**: The audit boundary that produces one replay manifest on close. On HTTP, maps 1:1 to the `mcp-session-id` lifetime. On stdio, an audit-only concept — core has no session concept on stdio.

### Audit

**Audit event**: A tamper-evident record of a single tool call, HMAC-chained and covered by a session-level Merkle proof. `AuditEvent` is a discriminated union on `sensitivityTier`. _Avoid_: bare "event"

**Sensitivity tier**: The discriminant of `AuditEvent` — `'low'`, `'medium'`, or `'high'`. Determines whether the event stores plaintext or an encrypted payload. _Avoid_: "data classification", bare "sensitivity"

**Sensitivity resolver**: The factory that maps tool names to a sensitivity tier. Unknown tools always resolve to `'high'`.

**Replay manifest**: A session-level proof document — Merkle root over all audit events plus individual proofs, signed by the `SigningKeyProvider`. Proves what happened; does not re-execute until v4. _Avoid_: implying it replays anything

**Rejection**: A call mcpose refuses to forward. The rejection is thrown inside the middleware pipeline, so the audit middleware records an `outcome: 'rejected'` event (unless `includeRejections: false`) and the client receives an MCP error.

**Rejection reason**: The `RejectionReason` value in the MCP error `data` field, identifying why a call was rejected. _Avoid_: "error code", "block reason"

### Keys and signing

**Signing secret**: The private root held only by the `SigningKeyProvider`; every subkey and the manifest signature derive from it via `sign()`, and it never leaves the process. _Avoid_: bare "key", "signing key"

**Key id**: A public identifier for the signing secret — published as `signedBy` on a replay manifest, names which key signed it, and is never key material. _Avoid_: treating it as secret or as the chain key

**Chain key**: The private HMAC key for the per-entry audit chain, derived from the signing secret via the oracle — never from the key id. _Avoid_: conflating with key id

**Event key**: A per-event AES-256 key protecting a high-tier payload, derived from a private encryption root plus the session id, chain position, and event id — never from any public value. Distinct per event even when a request id is reused.

**Audit format version**: The `mcpose/v2/...` domain labels versioning the chain preimage, key derivations, Merkle tags, and manifest signature. Changing any of them is a format break and follows the ritual in `.claude/skills/mcpose-audit-invariants` (ADR-0004).

### Events and replay

**Telemetry event**: An observability signal emitted to `onTelemetry` for routing to OTEL or a custom backend, discriminated on `type`: `'tool_call'` per call, `'backend_degraded'` when a mesh backend drops out of a list. _Avoid_: bare "event"

**Degradation**: A mesh returning the live backends' entries after one upstream failed a list call, reported as a `'backend_degraded'` telemetry event. Distinct from a rejection: nothing was refused, something is missing. _Avoid_: "partial failure", "fallback"

**SSE event**: A server-sent event stored in `PersistentEventStore` for reconnect replay. Transport detail only. _Avoid_: bare "event"

**SSE replay**: A reconnecting HTTP client replaying missed SSE events via `PersistentEventStore`. Transport concern, live in v1.2. _Avoid_: "session replay"

**Session replay**: Full re-execution of a session's tool calls from a replay manifest. v4 only. _Avoid_: conflating with SSE replay

## Relationships

- A **client** sends requests to the **proxy**; the proxy forwards them to the **upstream**
- A **mesh** forwards to one of many **upstreams**, chosen by the **backend key** in the **namespaced name**
- A **session** groups **audit events** and closes with a **replay manifest**
- An **audit event**'s **sensitivity tier** determines whether it stores plaintext or encrypted payload
- A **delegation chain** on `ProxyContext` records which agents delegated to which before reaching mcpose
- **Tamper-evidence** is anchored by the **signed replay manifest** (the signature covers every manifest field, not just the Merkle root); the per-entry HMAC **chain** links events under a private **chain key**, while the **key id** is public and identifies the signer only

## Example dialogue

> **Dev:** "When an agent delegates a call through mcpose, does the audit event capture the whole delegation chain?"
> **Domain expert:** "If the host stamps `delegatedFrom` on the `ProxyContext`, the audit middleware records it on the event and it is covered by the chain. Core itself does not extract delegation from requests yet — that lands with the v3 delegation spec."

## Flagged ambiguities

- "replay" means SSE reconnect replay (v1.2, transport) and session re-execution (v4, audit) — always qualify
- "key" / `keyId` was used to mean both a public identifier and secret key material — resolved: the **key id** is public-only; all **chain key** / **event key** material derives from the **signing secret** via the oracle (ADR-0003)
