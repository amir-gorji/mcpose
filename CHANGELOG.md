# Changelog

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
