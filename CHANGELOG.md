# Changelog

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
