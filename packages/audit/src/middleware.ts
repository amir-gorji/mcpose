import { createCipheriv, randomBytes, createHmac } from 'node:crypto';
import type {
  AuditEvent,
  AuditMiddlewareHandle,
  AuditOptions,
  ReplayManifest,
  SensitivityTier,
} from './types.js';
import {
  canonicalJson,
  chainPreimageFields,
  computeChainHash,
  computeMerkleProof,
  computeMerkleRoot,
  sha256hex,
  stableStringify,
} from './chain.js';
import { markPassThroughObserver } from 'mcpose';
import type { Identity, ProxyContext, RejectionReason } from 'mcpose';

// Domain-separation labels for subkey derivation. The version segment lets the
// derivation scheme rotate without colliding with chains written under an old
// scheme. v1 → v2: canonical-JSON preimages, signed full manifest,
// domain-separated Merkle, per-position event keys, AEAD-bound ciphertexts.
// See ADR-0003 and ADR-0004.
const DOMAIN_CHAIN = Buffer.from('mcpose/v2/chain');
const DOMAIN_ENC = Buffer.from('mcpose/v2/enc');
const DOMAIN_MANIFEST = 'mcpose/v2/manifest';
const DOMAIN_EVENT_KEY = 'mcpose/v2/eventkey\0';
const DOMAIN_AAD = 'mcpose/v2/aad\0';

interface SessionState {
  events: AuditEvent[];
  prevChainHash: string;
  startedAt: string;
  identity: Identity;
}

function aesEncrypt(plaintext: string, key: Buffer, aad: string): string {
  if (key.length !== 32) {
    throw new RangeError(
      `aesEncrypt: expected a 32-byte key, got ${key.length}`,
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Per-event AES key. Bound to session + position + event id so no two
 * events can share a key even if a host reuses a ProxyContext (and with it
 * a requestId) across calls.
 */
function deriveEventKey(
  encRoot: Buffer,
  sessionId: string | undefined,
  position: number,
  eventId: string,
): Buffer {
  return createHmac('sha256', encRoot)
    .update(`${DOMAIN_EVENT_KEY}${sessionId ?? ''}\0${position}\0${eventId}`)
    .digest();
}

function anonymousIdentity(): Identity {
  return {
    sub: 'anonymous',
    type: 'service',
    roles: [],
    claims: {},
    resolvedAt: new Date().toISOString(),
    source: 'custom',
  };
}

function getRejectionReason(err: unknown): RejectionReason | undefined {
  const data = (err as { data?: { rejectionReason?: unknown } } | null)?.data;
  return typeof data?.rejectionReason === 'string'
    ? (data.rejectionReason as RejectionReason)
    : undefined;
}

export function createAuditMiddleware(
  options: AuditOptions,
): AuditMiddlewareHandle {
  const sessions = new Map<string, SessionState>();
  const includeRejections = options.includeRejections ?? true;
  const onAuditError: NonNullable<AuditOptions['onAuditError']> =
    options.onAuditError ?? ((err) => console.error(err));

  // Private subkeys, derived once from the signing secret THROUGH the oracle with
  // domain separation. The provider never exposes raw key bytes, and keyId must
  // NOT be used as key material — keyId is a public identifier, published in
  // ReplayManifest.signedBy. sign() is HMAC-SHA256 per the SigningKeyProvider
  // contract, hence a PRF suitable for key derivation.
  //   chainKey — keys the per-entry HMAC chain (forgery resistance)
  //   encRoot  — root for per-event AES-256 keys (high-tier confidentiality)
  // Cache the promise so concurrent first calls share one derivation; a failed
  // derivation clears the cache so a transient provider error is retryable.
  let subkeys: Promise<{ chainKey: Buffer; encRoot: Buffer }> | undefined;
  const deriveSubkeys = () => {
    subkeys ??= (async () => {
      const [chainKey, encRoot] = await Promise.all([
        options.signingKey.sign(DOMAIN_CHAIN),
        options.signingKey.sign(DOMAIN_ENC),
      ]);
      return { chainKey, encRoot };
    })();
    subkeys.catch(() => {
      subkeys = undefined;
    });
    return subkeys;
  };

  const inner: AuditMiddlewareHandle['middleware'] = async (req, next, ctx) => {
    // Subkey derivation runs BEFORE the upstream call: if the signing
    // provider is unavailable the call fails fast rather than running
    // unaudited.
    const { chainKey, encRoot } = await deriveSubkeys();
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const identity = ctx.identity ?? anonymousIdentity();
    const sessionId = ctx.sessionId;

    if (sessionId && !sessions.has(sessionId)) {
      sessions.set(sessionId, {
        events: [],
        prevChainHash: '',
        startedAt,
        identity,
      });
    }

    const tool = req.params.name;
    const args = (req.params.arguments as Record<string, unknown>) ?? {};

    let result: unknown;
    let thrown: unknown;
    let threw = false;
    try {
      result = await next(req);
    } catch (err) {
      thrown = err;
      threw = true;
    }

    // Post-call audit section. Two invariants:
    // 1. Atomic append — no `await` between reading the position and
    //    pushing the event, so concurrent calls in one session cannot
    //    allocate duplicate positions (buildEvent is fully synchronous).
    // 2. Never throws — an audit failure is reported via onAuditError and
    //    must not fail (or mask the failure of) the tool call itself.
    try {
      const rejectionReason = threw ? getRejectionReason(thrown) : undefined;
      const outcome: AuditEvent['outcome'] = !threw
        ? 'success'
        : rejectionReason !== undefined
          ? 'rejected'
          : 'error';

      if (outcome !== 'rejected' || includeRejections) {
        let tier: SensitivityTier;
        try {
          tier = options.sensitivityResolver(tool, identity, args);
        } catch (err) {
          onAuditError(err, {
            tool,
            requestId: ctx.requestId,
            ...(sessionId === undefined ? {} : { sessionId }),
          });
          tier = 'high';
        }

        const session = sessionId ? sessions.get(sessionId) : undefined;
        const position = session?.events.length ?? 0;
        const event = buildEvent({
          ctx,
          identity,
          tool,
          args,
          result: threw ? undefined : result,
          startedAt,
          endedAt: new Date().toISOString(),
          duration_ms: Math.round(performance.now() - start),
          outcome,
          rejectionReason,
          error:
            outcome === 'error'
              ? {
                  name: thrown instanceof Error ? thrown.name : 'Error',
                  message:
                    thrown instanceof Error ? thrown.message : String(thrown),
                }
              : undefined,
          position,
          prevChainHash: session?.prevChainHash ?? '',
          tier,
          chainKey,
          encRoot,
        });
        if (session) {
          session.events.push(event);
          session.prevChainHash = event.chainHash;
        }
        await options.onEvent(event);
      }
    } catch (err) {
      onAuditError(err, {
        tool,
        requestId: ctx.requestId,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    }

    if (threw) throw thrown;
    return result as Awaited<ReturnType<typeof next>>;
  };
  const middleware = markPassThroughObserver(inner);

  const closeSession: AuditMiddlewareHandle['closeSession'] = async (
    sessionId,
  ) => {
    const session = sessions.get(sessionId);
    if (!session) return undefined;
    sessions.delete(sessionId);
    if (session.events.length === 0) return undefined;

    const hashes = session.events.map((e) => e.chainHash);
    const merkleRoot = computeMerkleRoot(hashes);
    const merkleProofs = hashes.map((_, i) => computeMerkleProof(hashes, i));

    // The signature covers the ENTIRE manifest (domain-separated, canonical
    // serialization) — signing only the Merkle root would leave sessionId,
    // identity, eventCount, and the proofs swappable after the fact.
    const unsigned: Omit<ReplayManifest, 'signature'> = {
      sessionId,
      identity: session.identity,
      startedAt: session.startedAt,
      closedAt: new Date().toISOString(),
      eventCount: session.events.length,
      merkleRoot,
      merkleProofs,
      signedBy: options.signingKey.keyId,
    };
    const payload = canonicalJson({
      domain: DOMAIN_MANIFEST,
      manifest: unsigned,
    });
    const signature = (
      await options.signingKey.sign(Buffer.from(payload))
    ).toString('hex');

    const manifest: ReplayManifest = { ...unsigned, signature };

    await options.onManifest?.(manifest);
    return manifest;
  };

  return { middleware, closeSession };
}

/** Rebuilds the exact signed payload for a manifest (used by verifiers). */
export function manifestSigningPayload(
  manifest: Omit<ReplayManifest, 'signature'>,
): string {
  const {
    sessionId,
    identity,
    startedAt,
    closedAt,
    eventCount,
    merkleRoot,
    merkleProofs,
    signedBy,
  } = manifest;
  return canonicalJson({
    domain: DOMAIN_MANIFEST,
    manifest: {
      sessionId,
      identity,
      startedAt,
      closedAt,
      eventCount,
      merkleRoot,
      merkleProofs,
      signedBy,
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

interface BuildParams {
  ctx: ProxyContext;
  identity: Identity;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  startedAt: string;
  endedAt: string;
  duration_ms: number;
  outcome: AuditEvent['outcome'];
  rejectionReason: RejectionReason | undefined;
  error: { name: string; message: string } | undefined;
  position: number;
  prevChainHash: string;
  tier: SensitivityTier;
  chainKey: Buffer;
  encRoot: Buffer;
}

/** Fully synchronous — position allocation relies on that (no await between read and append). */
function buildEvent(p: BuildParams): AuditEvent {
  const withoutChainHash = {
    id: p.ctx.requestId,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    ...(p.ctx.sessionId !== undefined ? { sessionId: p.ctx.sessionId } : {}),
    ...(p.ctx.delegatedFrom !== undefined
      ? { delegatedFrom: p.ctx.delegatedFrom }
      : {}),
    identity: p.identity,
    tool: p.tool,
    duration_ms: p.duration_ms,
    outcome: p.outcome,
    ...(p.rejectionReason !== undefined
      ? { rejectionReason: p.rejectionReason }
      : {}),
    ...(p.error !== undefined ? { error: p.error } : {}),
    inputHash: sha256hex(stableStringify(p.args)),
    outputHash: sha256hex(stableStringify(p.result ?? null)),
    replayManifestPosition: p.position,
  };

  const chainHash = computeChainHash(
    chainPreimageFields(withoutChainHash as Omit<AuditEvent, 'chainHash'>),
    p.prevChainHash,
    p.chainKey,
  );

  const base = { ...withoutChainHash, chainHash };

  // Fail CLOSED: only explicit low/medium get plaintext; any other tier
  // value — including garbage from a user-supplied resolver — encrypts.
  if (p.tier === 'low' || p.tier === 'medium') {
    return {
      ...base,
      sensitivityTier: p.tier,
      inputRaw: p.args,
      outputRaw: p.result,
    };
  }
  const eventKey = deriveEventKey(
    p.encRoot,
    p.ctx.sessionId,
    p.position,
    base.id,
  );
  return {
    ...base,
    sensitivityTier: 'high',
    inputEncrypted: aesEncrypt(
      stableStringify(p.args),
      eventKey,
      `${DOMAIN_AAD}${base.id}\0input`,
    ),
    outputEncrypted: aesEncrypt(
      stableStringify(p.result ?? null),
      eventKey,
      `${DOMAIN_AAD}${base.id}\0output`,
    ),
  };
}
