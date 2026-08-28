import type {
  Identity,
  ProxyIdentity,
  RejectionReason,
  ToolMiddleware,
} from 'mcpose';

// ── Sensitivity ────────────────────────────────────────────────────────────────

export type SensitivityTier = 'low' | 'medium' | 'high';

export type SensitivityResolverFn = (
  tool: string,
  identity: Identity,
  args: Record<string, unknown>,
) => SensitivityTier;

/**
 * Override passed to `createSensitivityResolver`. Receives the static map's
 * resolution as `mapTier` (already defaulted to `'high'` for unknown tools)
 * so it can fall back: `(tool, id, args, mapTier) => mapTier`.
 */
export type SensitivityOverrideFn = (
  tool: string,
  identity: Identity,
  args: Record<string, unknown>,
  mapTier: SensitivityTier,
) => SensitivityTier;

// ── Signing ────────────────────────────────────────────────────────────────────

export interface SigningKeyProvider {
  sign(data: Buffer): Promise<Buffer>;
  keyId: string;
  algorithm: 'HMAC-SHA256';
}

// ── Audit events ───────────────────────────────────────────────────────────────

export interface AuditEventBase {
  /** Equals the ProxyContext requestId. */
  id: string;
  /** ISO timestamp captured before the upstream call started. */
  startedAt: string;
  /** ISO timestamp captured after the upstream call settled. */
  endedAt: string;
  sessionId?: string;
  identity: Identity;
  delegatedFrom?: Identity[];
  /**
   * The proxy instance that recorded this event, from `ProxyContext.proxy`.
   * Provenance, not a principal — never part of `delegatedFrom` (ADR-0012).
   */
  proxy?: ProxyIdentity;
  tool: string;
  duration_ms: number;
  outcome: 'success' | 'rejected' | 'error';
  /** Present when outcome is 'rejected' (from the MCP error's data field). */
  rejectionReason?: RejectionReason;
  /** Present when outcome is 'error': what the upstream call threw. */
  error?: { name: string; message: string };
  inputHash: string;
  outputHash: string;
  chainHash: string;
  replayManifestPosition: number;
}

export type LowAuditEvent = AuditEventBase & {
  sensitivityTier: 'low';
  inputRaw: Record<string, unknown>;
  outputRaw: unknown;
};

export type MediumAuditEvent = AuditEventBase & {
  sensitivityTier: 'medium';
  inputRaw: Record<string, unknown>;
  outputRaw: unknown;
};

export type HighAuditEvent = AuditEventBase & {
  sensitivityTier: 'high';
  inputEncrypted: string;
  outputEncrypted: string;
};

export type AuditEvent = LowAuditEvent | MediumAuditEvent | HighAuditEvent;

// ── Merkle + ReplayManifest ────────────────────────────────────────────────────

export interface MerkleProof {
  index: number;
  siblings: string[];
  directions: ('left' | 'right')[];
}

export interface ReplayManifest {
  sessionId: string;
  identity: Identity;
  /**
   * The proxy instance that produced this session's trail, captured when
   * the session was first seen. Covered by the signature like every other
   * field (ADR-0004, ADR-0012).
   */
  proxy?: ProxyIdentity;
  startedAt: string;
  closedAt: string;
  eventCount: number;
  merkleRoot: string;
  merkleProofs: MerkleProof[];
  signedBy: string;
  /**
   * HMAC over the canonical serialization of the ENTIRE manifest (every
   * field above, domain-separated) — not just the Merkle root. Verify with
   * `verifyManifestSignature`.
   */
  signature: string;
}

// ── Audit options + handle ─────────────────────────────────────────────────────

export interface AuditOptions {
  signingKey: SigningKeyProvider;
  sensitivityResolver: SensitivityResolverFn;
  onEvent: (event: AuditEvent) => void | Promise<void>;
  /**
   * Called with the finished ReplayManifest when the host calls closeSession().
   *
   * Why this exists: ToolMiddleware is a pure per-request function with no
   * lifecycle hooks. Sessions are owned by the HTTP transport, not by
   * middleware. There is no in-band way for middleware to observe session close.
   * This callback gives consumers a push-based way to receive the manifest
   * exactly when the host signals the session has ended — mirroring how audit
   * substrates in financial systems work: the host controls the flush boundary;
   * the audit layer reacts.
   */
  onManifest?: (manifest: ReplayManifest) => void | Promise<void>;
  /**
   * Record events for rejected calls (hidden tools etc.).
   * @default true
   */
  includeRejections?: boolean;
  /**
   * Called when the audit layer itself fails (event serialization, a
   * throwing onEvent sink). The audit layer NEVER throws into the tool-call
   * path; failures are reported here instead.
   * @default console.error
   */
  onAuditError?: (
    err: unknown,
    info: { tool: string; requestId: string; sessionId?: string },
  ) => void;
}

export interface AuditMiddlewareHandle {
  middleware: ToolMiddleware;
  /**
   * Signal that a session has ended. Computes the Merkle tree over all audit
   * events for the session, signs the full manifest, fires onManifest, and
   * returns the ReplayManifest. Returns undefined if the session had no
   * events or is unknown.
   */
  closeSession(sessionId: string): Promise<ReplayManifest | undefined>;
}
