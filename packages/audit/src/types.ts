import type {
  Identity,
  PromptMiddleware,
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

// ── Cryptographic erasure ──────────────────────────────────────────────────────

/** Evidence that a subject's key was destroyed, returned by `destroy`. */
export interface SubjectKeyTombstone {
  /** ISO timestamp of the destruction. */
  destroyedAt: string;
}

/**
 * Custody of the per-subject keys that make erasable mode erasable (ADR-0018).
 *
 * Supplying one to `AuditOptions.keyStore` switches the audit layer into
 * erasable mode: per-event encryption keys and the keyed payload hashes then
 * derive from the stored subject key rather than from the signing secret, so
 * `destroy(subjectId)` makes that subject's recorded payloads permanently
 * unreadable and unconfirmable. The chain and the manifest are untouched.
 *
 * These keys are private key material with the same handling rules as the
 * signing secret: they must never be logged, exported, or written into an
 * event, a manifest, or telemetry. An implementation that stores them in the
 * clear voids the encryption guarantee for every subject in it.
 */
export interface SubjectKeyStore {
  /**
   * The subject's 256-bit key, created at random on first use. Called before
   * every audited call in erasable mode, so it must not be memoized in a way
   * that outlives `destroy`: a subject that calls again after erasure gets a
   * fresh key, and the old events stay dead.
   *
   * A rejection fails the audited call (the pre-call failure stage) rather
   * than letting it run unaudited.
   */
  getOrCreate(subjectId: string): Promise<Buffer>;
  /**
   * Permanently removes the subject's key and returns the tombstone that
   * evidences the erasure. Idempotent: destroying an unknown subject still
   * returns a tombstone, because "this subject holds no key" is the state the
   * caller asked for either way.
   */
  destroy(subjectId: string): Promise<SubjectKeyTombstone>;
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
   *
   * Required, and covered by the chain unconditionally (ADR-0019). While it
   * was omitted when absent, an event with no `proxy` and an event whose
   * `proxy` was stripped produced the same preimage, so deleting recorded
   * provenance was not chain-detectable.
   */
  proxy: ProxyIdentity;
  /**
   * Present ONLY on events recorded for a prompt call (`prompts/get`), where
   * `tool` holds the prompt name. An absent `kind` means a tool call, so
   * every event recorded before prompts were audited keeps its meaning and
   * its chain preimage (additive within v2, ADR-0012 and ADR-0014).
   */
  kind?: 'prompt';
  /**
   * Present ONLY on events recorded in erasable mode, where the per-event
   * encryption key and the keyed `inputHash`/`outputHash` derive from a
   * destroyable subject key instead of the signing secret (ADR-0018).
   *
   * Optional and covered by the chain under the ADR-0012 omission rule,
   * exactly as `kind` is: an absent marker means default mode with plain
   * `sha256` hashes, so events recorded before erasable mode existed keep
   * their preimage, and a stored event cannot be silently reinterpreted
   * under the wrong hash scheme.
   */
  erasable?: true;
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
   *
   * Required, and included in the signing payload unconditionally
   * (ADR-0019), so stripping it from a stored manifest fails the signature
   * rather than rebuilding a payload that verifies.
   */
  proxy: ProxyIdentity;
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
  /**
   * Supply a store to run in ERASABLE mode (ADR-0018). Omit it and the audit
   * layer behaves exactly as it always has, byte for byte: same preimages,
   * same ciphertexts, same plain `sha256` payload hashes, no `erasable`
   * marker on any event.
   *
   * With a store, the erasure unit is the data subject — the resolved
   * `identity.sub` of each event, with anonymous events sharing the
   * `anonymousIdentity()` bucket — and `destroy(sub)` renders that subject's
   * recorded payloads permanently undecryptable and unconfirmable. Chain and
   * manifest verification are unaffected, because payloads are bound to the
   * chain only through their hashes.
   *
   * Key custody becomes your responsibility: see the README's erasable-mode
   * section before choosing a store.
   */
  keyStore?: SubjectKeyStore;
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
   * Audits `prompts/get` calls. Wire it into
   * `ProxyOptions.promptMiddleware`; it shares the session chain with
   * `middleware`, so tool and prompt events interleave in one trail.
   * Prompt events carry `kind: 'prompt'` (ADR-0014).
   */
  promptMiddleware: PromptMiddleware;
  /**
   * Signal that a session has ended. Computes the Merkle tree over all audit
   * events for the session, signs the full manifest, fires onManifest, and
   * returns the ReplayManifest. Returns undefined if the session had no
   * events or is unknown.
   */
  closeSession(sessionId: string): Promise<ReplayManifest | undefined>;
}
