# Changelog

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
