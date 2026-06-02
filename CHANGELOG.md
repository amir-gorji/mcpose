# Changelog

## [2.0.1] - 2026-06-02

### Changed

- Only README.md file update

## [2.0.0] - 2026-06-02

### Added

- **`@mcpose/audit`** — new package providing a tamper-evident, HMAC-chained audit trail for every tool call.
  - `createAuditMiddleware(options)` — returns `{ middleware, closeSession }`. Produces `AuditEvent` records with a sequential HMAC chain (`chainHash`) and per-event SHA-256 input/output hashes.
  - `createSensitivityResolver(map, override?)` — maps tool names to `'low' | 'medium' | 'high'` sensitivity tiers; unknown tools always resolve to `'high'`.
  - `createDefaultSigningKeyProvider(secret)` — HMAC-SHA256 signing key provider (FIPS-compatible, SHA-256); use as a default or implement `SigningKeyProvider` against a KMS.
  - `AuditEvent` discriminated union on `sensitivityTier`: `low`/`medium` tiers store `inputRaw`/`outputRaw`; `high` tier stores `inputEncrypted`/`outputEncrypted` (AES-256-GCM, per-event derived key).
  - `closeSession(sessionId)` — computes a Merkle tree over all chain hashes for the session, signs the root, fires `onManifest`, and returns a `ReplayManifest`. Returns `undefined` if the session had no events.
  - `ReplayManifest` — Merkle-proof document per session; lets any third party verify a single event against the root without replaying the full log.
  - `verifyMerkleProof(leafHash, proof, root)` — exported utility for offline verification.
  - `onManifest` on `AuditOptions` — push-based delivery of the `ReplayManifest` at session close. Separate from `ToolMiddleware` because middleware has no lifecycle hooks; the host controls the flush boundary via `closeSession()`.

- **`@mcpose/testing`** — new package with compliance assertion helpers.
  - `assertAuditChainIntegrity(events)` — verifies sequential `replayManifestPosition` and no duplicate `chainHash` values (tamper detection).
  - `assertReplayManifestValid(events, manifest)` — verifies event count and Merkle proof for every event against the manifest root.
  - `assertPiiRedacted(event, patterns)` — asserts no regex pattern matches plaintext fields; automatically passes for high-sensitivity (encrypted) events.
  - `assertDelegationHonored(chain)` — asserts delegation chain is non-empty and every entry has a `sub`.

- **Identity resolution** — `resolveIdentity` hook on `HttpProxyOptions`. Called once per new session; resolved `Identity` is stamped on every `ProxyContext` within that session. Errors thrown here abort the session with a 401.
- **`Identity` type** — `{ sub, type, displayName?, roles, claims, resolvedAt, source }` exported from `mcpose`. `type` is `'human' | 'agent' | 'service'`; `source` is `'jwt' | 'mtls' | 'apikey' | 'custom'`.
- **Agent delegation chain** — `delegatedFrom?: Identity[]` on `ProxyContext` for recording A2A agent handoff sequences.
- **mTLS** — `tlsOptions` on `HttpProxyOptions`; when provided, `startHttpProxy` listens on HTTPS and requires client certificates.
- **SSE reconnect replay** — `startHttpProxy` now defaults to an in-memory `EventStore` so dropped connections can replay missed notifications on reconnect. Pass `eventStore: null` to disable. Supply a custom `PersistentEventStore` implementation for multi-instance deployments.
- **`onSessionClosed` hook** on `HttpProxyOptions` — called when a session closes (client DELETE or TTL expiry). Wire `auditHandle.closeSession` here to flush the `ReplayManifest` for the session.
- **`onTelemetry` hook** on `ProxyOptions` — emits a `TelemetryEvent` after every tool call with timing, outcome, tool name, and identity. Wire to `@mcpose/otel` (coming v3) or any custom sink.
- **Structured `RejectionReason`** in MCP error `data` field on every blocked call — `TOOL_HIDDEN`, `RESOURCE_HIDDEN`, `SESSION_LIMIT`, `BODY_LIMIT`, and stubs for v3 reasons (`POLICY_DENIED`, `IDENTITY_UNRESOLVED`, `CONSENT_MISSING`, `SENSITIVITY_BLOCKED`, `DELEGATION_INVALID`, `BUDGET_EXCEEDED`). Top-level error code is unchanged; zero migration burden on existing clients.
- **Monorepo** — migrated to pnpm workspaces + Turborepo. `packages/core` (`mcpose`), `packages/audit` (`@mcpose/audit`), `packages/testing` (`@mcpose/testing`). GitHub Actions CI updated; `npm publish --provenance` on tag.

### Changed

- `ProxyContext` gains `identity?`, `delegatedFrom?`, and `policy?: never` (reserved for v3). Existing middleware is unaffected — all fields are optional.
- `HttpProxyOptions` `eventStore` field added; `startHttpProxy` no longer documents SSE replay as a limitation.
- Tagline updated to *"The audit and governance layer for MCP"*.

---

## [1.2.0] - 2026-03-08

### Added
- `onRequest` hook on `HttpProxyOptions` — called for every incoming request before MCP handling; return `false` to block (caller writes its own response) or throw to return a 401.
- `onError` callback on `HttpProxyOptions` — replaces `console.error` for unhandled errors inside the HTTP server handler.
- `maxBodyBytes` on `HttpProxyOptions` — caps POST body size; returns 413 when exceeded (default: 4 MB).
- `maxSessions` on `HttpProxyOptions` — caps concurrent MCP sessions; excess initialization requests return 503.
- `sessionTtlMs` on `HttpProxyOptions` — auto-closes sessions after the given duration.
- `listToolsMiddleware` on `ProxyOptions` — middleware pipeline for `list_tools` responses, composable alongside `toolMiddleware`.
- `ListToolsMiddleware` type exported from the package.
- `ProxyContext` interface and `createProxyContext()` function exported from the package — carry `requestId`, `transport`, `sessionId`, `headers`, and `signal` through middleware.
- URL protocol validation in `createBackendClient` — only `http:` and `https:` are accepted; other protocols throw a descriptive error immediately.
- Unit coverage for all new HTTP options, `listToolsMiddleware`, `ProxyContext`, and backend URL validation.

### Changed
- `Middleware<Req, Res>` now receives `context: ProxyContext` as its third argument. Existing middleware that ignores the extra parameter continues to work at runtime; typed implementations should add `context: ProxyContext` to their signatures.
- `runToolMiddleware()` in `mcpose/testing` accepts an optional `context` argument (defaults to a fresh `createProxyContext()`).
- `hiddenTools` filtering is applied both inside and after `listToolsMiddleware`, so no middleware can accidentally expose a hidden tool.
- HTTP request headers are normalized before reaching `ProxyContext` — array-valued headers are joined with `, `.

## [1.1.1] - 2026-03-01

### Fixed
- Proxy capabilities now mirror the upstream server instead of always advertising tools, resources, and prompts.
- `startHttpProxy()` now advertises list-changed support only when the upstream does, so standard MCP clients can discover and consume list-change notifications.
- Active HTTP proxy sessions are now closed during `http.Server.close()`.
- Downstream abort signals and upstream progress updates now flow through proxy tool, resource, and prompt calls.
- `createMockBackendClient()` now includes capability and notification hooks needed by the full public API.

### Added
- Unit coverage for capability mirroring, notification fanout, and forwarded request options.

## [1.1.0] - 2026-02-28

### Added
- `startHttpProxy(backend, options, httpOptions)` — starts the proxy over Streamable HTTP with stateful sessions keyed by `mcp-session-id`.
- `HttpProxyOptions` interface (`port`, `host`, `path`) exported from the package.
- Upstream `ToolListChanged`, `ResourceListChanged`, and `PromptListChanged` notifications fanned out to all active HTTP sessions.
- Full integration test suite for `startHttpProxy` covering routing, session lifecycle, and unknown session rejection.

### Changed
- Doc comments across `core.ts`, `backendClient.ts`, `middleware.ts`, and `testing.ts` condensed for readability.

## [1.0.0] - 2026-02-27

Initial release.
