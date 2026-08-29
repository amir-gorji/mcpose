/**
 * PII redaction + audit: the canonical mcpose example.
 *
 * This demonstrates the origin use case for mcpose: an MCP proxy serving
 * financial data to LLM agents, where every tool response must be scrubbed
 * of PII before it reaches the LLM or the audit log.
 *
 * Architecture:
 *   LLM client → mcpose proxy → upstream MCP server
 *                    │
 *                    ├── PII middleware (redacts before audit sees it)
 *                    └── Audit middleware (records tamper-evident events)
 *
 * Prerequisites:
 *   - Node.js 18+
 *   - An upstream MCP server (HTTP/SSE or stdio)
 *   - Durable sinks for audit events and replay manifests
 *
 * Run:
 *   npx tsx pii-redaction-audit.ts
 */

import type * as http from 'node:http';
import { createBackendClient, startHttpProxy, mapToolResult } from 'mcpose';
import type { ToolMiddleware, Identity } from 'mcpose';
import {
  createAuditMiddleware,
  createDefaultSigningKeyProvider,
  createSensitivityResolver,
} from '@mcpose/audit';

// ---------------------------------------------------------------------------
// 1. Application-supplied values.  Replace these with your own.
// ---------------------------------------------------------------------------

// The upstream MCP server to proxy.  Can be a URL (HTTP/SSE) or a
// command+args pair (stdio).  See `BackendConfig` in the mcpose API
// reference for all options.
const UPSTREAM_URL = process.env.UPSTREAM_URL ?? 'http://localhost:9000/mcp';

// The signing secret for the audit HMAC chain.  In production, use a KMS
// and implement `SigningKeyProvider`.  `createDefaultSigningKeyProvider`
// is suitable for development and single-trust deployments.
const AUDIT_SECRET = process.env.AUDIT_SECRET ?? 'dev-secret-change-me';

// ---------------------------------------------------------------------------
// 2. PII redaction middleware.
//
//    Runs *before* the audit middleware in the pipeline (see middleware order
//    in step 4), so audit never sees raw PII.
// ---------------------------------------------------------------------------

const PII_PATTERNS: RegExp[] = [
  /\b\d{9}\b/g, // 9-digit IDs (social security style)
  /[A-Z]{2}\d{6}/g, // Alphanumeric codes (e.g. passport-style)
  /\b\d{16}\b/g, // 16-digit card numbers
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, // email addresses
];

function createPiiMiddleware(patterns: RegExp[]): ToolMiddleware {
  const scrub = (text: string): string =>
    patterns.reduce((t, re) => t.replace(re, '[REDACTED]'), text);

  const scrubValue = (value: unknown): unknown => {
    if (typeof value === 'string') return scrub(value);
    if (typeof value === 'number' && scrub(String(value)) !== String(value))
      return '[REDACTED]';
    if (Array.isArray(value)) return value.map(scrubValue);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, scrubValue(v)]),
      );
    return value;
  };

  // mapToolResult requires a handler per payload channel (text blocks,
  // non-text blocks, structuredContent), so a redaction cannot silently
  // miss one. Legacy { toolResult } results pass through untouched.
  return async (req, next) =>
    mapToolResult(await next(req), {
      onText: (block) => ({ ...block, text: scrub(block.text) }),
      // Images, audio, and embedded resources cannot be scrubbed by regex:
      // drop them rather than forward unredacted bytes.
      onOther: () => null,
      // structuredContent mirrors the text channel as JSON: walk the value
      // and redact matching strings and numbers in place. Scrubbing the
      // serialized form instead would turn a bare numeric match into
      // invalid JSON.
      onStructured: (structured) =>
        scrubValue(structured) as Record<string, unknown>,
    });
}

// ---------------------------------------------------------------------------
// 3. Audit middleware setup.
//
//    - `createSensitivityResolver` maps tool names to sensitivity tiers.
//      Unknown tools always resolve to `'high'`.
//    - `createDefaultSigningKeyProvider` derives subkeys from the secret
//      through the signing oracle.  The key id is public-only (ADR-0003).
// ---------------------------------------------------------------------------

// Map tools to sensitivity tiers.  Unknown tools default to `'high'`.
const sensitivityResolver = createSensitivityResolver({
  get_balance: 'low',
  search_trades: 'medium',
  transfer_funds: 'high',
});

const signingKey = createDefaultSigningKeyProvider(AUDIT_SECRET);

// Durable sinks.  Replace with your database / log system.
// `onEvent` receives every audit event as it happens.
// `onManifest` receives the signed ReplayManifest at session close.
const auditLog: { append: (e: unknown) => void } = {
  append: (event) => console.log('[audit event]', JSON.stringify(event)),
};

const manifestStore: { save: (m: unknown) => void } = {
  save: (manifest) =>
    console.log('[replay manifest]', JSON.stringify(manifest)),
};

const auditHandle = createAuditMiddleware({
  signingKey,
  sensitivityResolver,
  onEvent: (event) => auditLog.append(event),
  onManifest: (manifest) => manifestStore.save(manifest),
});

// ---------------------------------------------------------------------------
// 4. Identity resolution.
//
//    `resolveIdentity` runs once when an HTTP session is established.
//    The resolved `Identity` is stamped on every `ProxyContext` in that
//    session.  Errors abort the session with HTTP 401.
// ---------------------------------------------------------------------------

async function resolveIdentity(_req: http.IncomingMessage): Promise<Identity> {
  // In production, extract and verify a JWT from the Authorization header,
  // or use mTLS client certificate details.  This is a placeholder.
  return {
    sub: 'user-123',
    type: 'human',
    roles: ['trader'],
    claims: { desk: 'fixed-income' },
    resolvedAt: new Date().toISOString(),
    source: 'jwt',
  };
}

// ---------------------------------------------------------------------------
// 5. Wire everything together.
//
//    Middleware order matters: `[piiMW, auditHandle.middleware]` means the
//    PII middleware processes the response *first* (innermost), so the audit
//    layer sees already-redacted data.  See the Middleware model section in
//    the root README for the full explanation.
// ---------------------------------------------------------------------------

async function main() {
  const backend = await createBackendClient({ url: UPSTREAM_URL });

  const piiMW = createPiiMiddleware(PII_PATTERNS);

  const server = await startHttpProxy(
    backend,
    {
      name: 'pii-redaction-audit',
      toolMiddleware: [piiMW, auditHandle.middleware],
    },
    {
      port: 3000,
      resolveIdentity,
      // Flush the replay manifest when the session ends.  `onSessionClosed` is
      // fire-and-forget (void), so handle the rejection here rather than
      // returning the promise to a caller that will not await it.
      onSessionClosed: (sessionId) => {
        auditHandle.closeSession(sessionId).catch((err: unknown) => {
          console.error('closeSession failed:', err);
        });
      },
    },
  );

  console.error(`mcpose proxy listening on http://localhost:3000/mcp`);
  console.error(`Proxying → ${UPSTREAM_URL}`);
  console.error('PII patterns:', PII_PATTERNS.map((r) => r.source).join(', '));

  // Graceful shutdown.
  const shutdown = () => {
    console.error('\nShutting down...');
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
