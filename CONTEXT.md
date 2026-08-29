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

**mcpose ecosystem**: The full suite — `mcpose` core plus `@mcpose/audit`, `@mcpose/policy`, `@mcpose/testing`, and `@mcpose/otel`.

### Middleware

**Middleware**: A single composable function `(req, next, ctx) => Promise<result>`. Concrete types: `ToolMiddleware`, `ListToolsMiddleware`, `ResourceMiddleware`. _Avoid_: using to mean the proxy itself

**Pipeline**: A composed chain of middleware functions. _Avoid_: "middleware stack", "middleware chain"

### Identity and delegation

**Identity**: Who made a request. The `Identity` interface: `sub`, `type` (`human` | `agent` | `service`), `roles`, `claims`, `source`. _Avoid_: "caller", "user", "principal"

**Identity resolution**: The act of producing an `Identity` from a raw request, via the `resolveIdentity` hook. _Avoid_: "auth", "authentication"

**Delegation**: A single link in an agent-to-agent handoff — one `Identity` in the `delegatedFrom` array.

**Delegation chain**: The full sequence of agents that handed off the request before reaching mcpose, oldest-first. `delegatedFrom?: Identity[]` on `ProxyContext`. Core populates it from the presented chain the caller sends at `params._meta["mcpose/delegation"]`, read before the request-`_meta` strip; a chain the host stamps takes precedence (ADR-0016). _Avoid_: "agent chain", "call chain"

**Presented chain**: The delegation chain as it arrives on the wire, written by the previous hop. Attribution, never authorization: extraction gives every entry empty `roles` and `claims`, and a malformed payload is rejected with `DELEGATION_INVALID` (ADR-0016). _Avoid_: "delegation header", "trusted chain"

**Delegation loop**: A presented chain the resolved caller is already a link in, so the call has cycled back through this proxy. Rejected with `DELEGATION_INVALID` after identity resolution and inside the pipeline; unresolvable on stdio, where there is no identity to look for (ADR-0016). _Avoid_: "cycle detection", "hop limit"

**Proxy identity**: Which proxy instance handled a request — `proxy?: ProxyIdentity` (`{ name, version }`) on `ProxyContext`, stamped by `createProxyServer` from `ProxyOptions`. `name` is required and must be non-blank (#122), because a defaulted one records a whole fleet under one name; `version` still defaults to the mcpose library version. Provenance, not a principal: never an entry in `delegatedFrom`, and no part of the caller-attribution model (ADR-0012). It stays optional on `ProxyContext`, which a host can build by hand, but is **required** on every `AuditEvent` and `ReplayManifest` and covered by the chain unconditionally (ADR-0019), so the audit middleware rejects a context without one before the call runs. _Avoid_: "server identity", "instance id"

### Policy

**Policy rule**: One entry in the `@mcpose/policy` rule set, pairing an effect (`allow` | `deny`) with the roles and names it matches. An explicit deny beats every allow, and a call no rule allows is denied (ADR-0017). _Avoid_: "permission", "grant", "ACL entry"

**Policy decision**: The frozen `{ decision, ruleId?, reason? }` record the policy middleware stamps on `ctx.policy` before it calls `next` or throws. A record of a decision already made, never a handle to query. _Avoid_: "policy result", "verdict"

**Call budget**: A per-session cap on how many calls reach the policy layer, counted in memory on one middleware instance and emitting `BUDGET_EXCEEDED` when exhausted. Counts calls, never money. _Avoid_: "quota", "rate limit", "cost budget"

### Sessions

**Session**: The audit boundary that produces one replay manifest on close. On HTTP, maps 1:1 to the `mcp-session-id` lifetime. On stdio, an audit-only concept — core has no session concept on stdio.

### Audit

**Audit event**: A tamper-evident record of a single tool call or prompt call, HMAC-chained and covered by a session-level Merkle proof. `AuditEvent` is a discriminated union on `sensitivityTier`. A prompt call is recorded with `kind: 'prompt'` and the prompt name in `tool`; an absent `kind` means a tool call (ADR-0014). _Avoid_: bare "event"

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
- A **policy rule** matches an **identity**'s roles against a tool or prompt name and produces a **policy decision**; composing the policy middleware inside the audit middleware is what puts a denial in the **audit trail**
- **Tamper-evidence** is anchored by the **signed replay manifest** (the signature covers every manifest field, not just the Merkle root); the per-entry HMAC **chain** links events under a private **chain key**, while the **key id** is public and identifies the signer only

## Example dialogue

> **Dev:** "When an agent delegates a call through mcpose, does the audit event capture the whole delegation chain?"
> **Domain expert:** "Yes. Core reads the presented chain out of the request before the `_meta` strip and puts it on the `ProxyContext`, the audit middleware records it on the event, and it is covered by the chain. A chain the host stamps itself still wins. What the entries never carry is roles or claims: the chain says who handed off, not what they may do."

## Flagged ambiguities

- "replay" means SSE reconnect replay (v1.2, transport) and session re-execution (v4, audit) — always qualify
- "key" / `keyId` was used to mean both a public identifier and secret key material — resolved: the **key id** is public-only; all **chain key** / **event key** material derives from the **signing secret** via the oracle (ADR-0003)
