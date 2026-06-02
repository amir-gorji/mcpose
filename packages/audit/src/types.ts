import type { Identity, RejectionReason, ToolMiddleware } from 'mcpose';

export type { ToolMiddleware };

// ── Sensitivity ────────────────────────────────────────────────────────────────

export type SensitivityTier = 'low' | 'medium' | 'high';

export type SensitivityResolverFn = (
  tool: string,
  identity: Identity,
  args: Record<string, unknown>,
) => SensitivityTier;

// ── Signing ────────────────────────────────────────────────────────────────────

export type HashAlgorithm = 'SHA-256';

export interface SigningKeyProvider {
  sign(data: Buffer): Promise<Buffer>;
  keyId: string;
  algorithm: 'HMAC-SHA256';
}

// ── Cost ───────────────────────────────────────────────────────────────────────

export interface CostMetadata {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

// ── Audit events ───────────────────────────────────────────────────────────────

export interface AuditEventBase {
  /** Equals the ProxyContext requestId. */
  id: string;
  timestamp: string;
  sessionId?: string;
  identity: Identity;
  delegatedFrom?: Identity[];
  tool: string;
  duration_ms: number;
  streamedChunkCount?: number;
  outcome: 'success' | 'rejected' | 'error';
  rejectionReason?: RejectionReason;
  cost?: CostMetadata;
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
  startedAt: string;
  closedAt: string;
  eventCount: number;
  merkleRoot: string;
  merkleProofs: MerkleProof[];
  signedBy: string;
  signature: string;
}

// ── Audit options + handle ─────────────────────────────────────────────────────

export interface AuditOptions {
  signingKey: SigningKeyProvider;
  hashAlgorithm?: HashAlgorithm;
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
  /** @default true */
  includeRejections?: boolean;
  /** @default true */
  includeCost?: boolean;
}

export interface AuditMiddlewareHandle {
  middleware: ToolMiddleware;
  /**
   * Signal that a session has ended. Computes the Merkle tree over all audit
   * events for the session, signs the root, fires onManifest, and returns the
   * ReplayManifest. Returns undefined if the session had no events or is
   * unknown.
   */
  closeSession(sessionId: string): Promise<ReplayManifest | undefined>;
}
