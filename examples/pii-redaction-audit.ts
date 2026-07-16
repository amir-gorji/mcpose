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

import { createBackendClient, startHttpProxy, hasToolContent } from 'mcpose';
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
  /\b\d{9}\b/g,          // 9-digit IDs (social security style)
  /[A-Z]{2}\d{6}/g,      // Alphanumeric codes (e.g. passport-style)
  /\b\d{16}\b/g,          // 16-digit card numbers
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,  // email addresses
];

function createPiiMiddleware(patterns: RegExp[]): ToolMiddleware {
  return async (req, next, ctx) => {
    const result = await next(req);

    // Narrow to a tool-call result (skip protocol-level results).
    if (!hasToolContent(result)) return result;

    return {
      ...result,
      content: result.content.map((item) =>
        item.type === 'text'
          ? {
              ...item,
              text: patterns.reduce(
                (t, re) => t.replace(re, '[REDACTED]'),
                item.text,
              ),
            }
          : item,
      ),
    };
  };
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
  get_balance:    'low',
  search_trades:  'medium',
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

async function resolveIdentity(
  req: Parameters<NonNullable<Parameters<typeof startHttpProxy>[2]>['resolveIdentity']>[0],
): Promise<Identity> {
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
      toolMiddleware: [piiMW, auditHandle.middleware],
    },
    {
      port: 3000,
      resolveIdentity,
      // Flush the replay manifest when the session ends.
      onSessionClosed: (sessionId) => auditHandle.closeSession(sessionId),
    },
  );

  console.error(`mcpose proxy listening on http://localhost:3000/mcp`);
  console.error(`Proxying → ${UPSTREAM_URL}`);
  console.error('PII patterns:', PII_PATTERNS.map((r) => r.source).join(', '));

  // Graceful shutdown.
  const shutdown = async () => {
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
