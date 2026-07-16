/**
 * Governance proxy: tool visibility and telemetry with a mock backend.
 *
 * This example demonstrates mcpose's governance features: hiding tools,
 * passing tools straight through the pipeline, and emitting telemetry on
 * every call, without requiring an external MCP server.
 *
 * Architecture:
 *   LLM client → mcpose proxy (mock backend)
 *                  │
 *                  ├── hiddenTools       : blocked entirely
 *                  ├── passThroughTools  : forwarded raw, no middleware
 *                  └── everything else   : routed through toolMiddleware
 *
 * Prerequisites:
 *   - Node.js 18+
 *   - Nothing else.  This example uses `createMockBackendClient` so it
 *     runs with zero external dependencies.
 *
 * Run:
 *   npx tsx governance-proxy.ts
 */

import { createProxyServer } from 'mcpose';
import { createMockBackendClient } from 'mcpose/testing';
import type { ToolMiddleware, Identity } from 'mcpose';

// ---------------------------------------------------------------------------
// 1. Mock backend: define the tools our proxy will govern.
//
//    `createMockBackendClient` builds an in-memory BackendClient. No
//    process, no network, no upstream server needed.  Each tool can return
//    a static result or a factory function of `(params) => result`.
// ---------------------------------------------------------------------------

const backend = createMockBackendClient({
  tools: [
    { name: 'get_balance',    description: 'Return the account balance.' },
    { name: 'search_trades',   description: 'Search trade history.' },
    { name: 'wire_transfer',   description: 'Initiate a wire transfer.' },
    { name: 'health_check',    description: 'Internal health check.' },
  ],
  callToolResponse: (params) => ({
    content: [{ type: 'text' as const, text: `mock response for ${params.name}` }],
  }),
});

// ---------------------------------------------------------------------------
// 2. Governance configuration.
//
//    Three routing paths exist for every tool (see the Proxy model in the
//    root README):
//
//    | Path            | Config            | Behavior                              |
//    |-----------------|-------------------|---------------------------------------|
//    | Hidden          | hiddenTools       | Omitted from list, rejected at call   |
//    | Pass-through    | passThroughTools  | Forwarded raw, all middleware skipped |
//    | Middleware      | (everything else) | Routed through toolMiddleware         |
//
//    `hiddenTools` wins over `passThroughTools` : a tool listed in both
//    is treated as hidden.
// ---------------------------------------------------------------------------

// Tools blocked entirely.  Calls are rejected with TOOL_HIDDEN.
const hiddenTools = ['wire_transfer'];

// Tools forwarded raw to the upstream.  Middleware never sees them.
const passThroughTools = ['health_check'];

// ---------------------------------------------------------------------------
// 3. Telemetry.
//
//    `onTelemetry` fires after every tool call (including rejected and
//    pass-through calls) with timing, outcome, tool name, and identity.
//    Wire it to your observability backend.
// ---------------------------------------------------------------------------

const telemetryEvents: Record<string, unknown>[] = [];

function onTelemetry(event: Record<string, unknown>) {
  telemetryEvents.push(event);
  console.log('[telemetry]', JSON.stringify(event));
}

// ---------------------------------------------------------------------------
// 4. Middleware: a simple logging layer.
//
//    Middleware follows the onion model: code runs before *and* after the
//    inner pipeline.  Only non-hidden, non-pass-through tools reach here.
// ---------------------------------------------------------------------------

const loggingMW: ToolMiddleware = async (req, next, ctx) => {
  const identity = ctx.identity?.displayName ?? ctx.identity?.sub ?? 'anonymous';
  console.error(`→ ${req.params.name}  (by ${identity})`);
  const result = await next(req);
  console.error(`← ${req.params.name}  done`);
  return result;
};

// ---------------------------------------------------------------------------
// 5. Identity: a static identity for the example.
//
//    In production, use `resolveIdentity` on `HttpProxyOptions` to extract
//    and verify a JWT or mTLS certificate on every new session.
// ---------------------------------------------------------------------------

const identity: Identity = {
  sub: 'trader-456',
  type: 'human',
  displayName: 'Alice',
  roles: ['trader', 'viewer'],
  claims: { desk: 'fixed-income', region: 'us-east' },
  resolvedAt: new Date().toISOString(),
  source: 'jwt',
};

// ---------------------------------------------------------------------------
// 6. Wire everything together.
//
//    `createProxyServer` builds a transport-agnostic Server.  In a real
//    app you would pass the same options to `startProxy` (stdio) or
//    `startHttpProxy` (HTTP/SSE) to bind a transport.
// ---------------------------------------------------------------------------

const server = createProxyServer(backend, {
  toolMiddleware: [loggingMW],
  hiddenTools,
  passThroughTools,
  onTelemetry,
});

console.error('Governance proxy server created.');
console.error('');
console.error('Routing table:');
console.error('  get_balance   → middleware  (loggingMW)');
console.error('  search_trades → middleware  (loggingMW)');
console.error('  wire_transfer → HIDDEN      (rejected with TOOL_HIDDEN)');
console.error('  health_check  → pass-through (raw forward, no middleware)');
console.error('');
console.error('Identity:', JSON.stringify(identity, null, 2));
console.error('');
console.error('To run this against a real upstream, replace createMockBackendClient');
console.error('with createBackendClient({ command: ..., args: ... }) for stdio,');
console.error('or createBackendClient({ url: ... }) for HTTP/SSE.');

// In a real app, call `await startProxy(backend, options)` or
// `await startHttpProxy(backend, options, httpOptions)` here.

// Graceful shutdown.
const shutdown = () => {
  console.error('\nShutting down...');
  server.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Signal readiness.  The server is ready; in a real deployment the
// transport would accept connections here.
console.error('\nReady.  Press Ctrl+C to exit.');
