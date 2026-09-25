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
import { hasToolContent, markPassThroughObserver } from 'mcpose';
import type {
  Identity,
  ProxyContext,
  ProxyIdentity,
  RejectionReason,
} from 'mcpose';

/**
 * What the audit layer needs from an audited request. Tool calls and prompt
 * fetches both expose a name and optional arguments, which is why one
 * implementation can serve both.
 */
interface AuditableRequest {
  params: { name: string; arguments?: Record<string, unknown> | undefined };
}

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
// Erasable mode only (ADR-0018): keys the payload hashes so that destroying a
// subject key destroys confirmability along with decryptability. A new label
// for a new mechanism is additive within v2 — no existing label changes, and
// no default-mode event is derived under it.
const DOMAIN_HASH_KEY = 'mcpose/v2/hashkey';

interface SessionState {
  events: AuditEvent[];
  prevChainHash: string;
  startedAt: string;
  identity: Identity;
  proxy: ProxyIdentity;
  /**
   * Calls admitted to this session whose event is not yet appended and
   * persisted, keyed by a per-call token. `closeSession` drains this before
   * sealing, so a call that is still awaiting the upstream when the session
   * is torn down (client DELETE, TTL expiry, shutdown) lands in the manifest
   * instead of emitting an orphan at position 0 (#168). The value names the
   * call so a drain that times out can report each straggler.
   */
  inflight: Map<symbol, { tool: string; requestId: string }>;
  /** Resolves the pending drain wait once `inflight` empties. */
  onDrained?: () => void;
  /**
   * The in-progress close, so concurrent `closeSession` calls share one
   * drain, one signature, and one manifest.
   */
  closing?: Promise<ReplayManifest | undefined>;
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

/**
 * Payload hash for one event.
 *
 * Default mode: plain `sha256`, unchanged and unkeyed, so a replay verifier
 * needs no key custody. Erasable mode: `HMAC-SHA256` under a subkey of the
 * subject key, so an adversary holding a candidate payload cannot confirm it
 * against an erased event's hash (ADR-0018). Both hash the same
 * `stableStringify` bytes, so only the key changes.
 */
function payloadHash(value: unknown, hashSubkey: Buffer | undefined): string {
  const serialized = stableStringify(value);
  return hashSubkey === undefined
    ? sha256hex(serialized)
    : createHmac('sha256', hashSubkey).update(serialized).digest('hex');
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
  const closeDrainTimeoutMs = options.closeDrainTimeoutMs ?? 30_000;
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

  // One implementation for both audited surfaces. A tool call and a prompt
  // fetch differ only in the event's `kind`: both requests carry a name and
  // optional arguments, and both share the session chain, so duplicating the
  // body would duplicate every invariant below with it (ADR-0014).
  const observe = async <Req extends AuditableRequest, Res>(
    kind: 'prompt' | undefined,
    req: Req,
    next: (req: Req) => Promise<Res>,
    ctx: ProxyContext,
    isInBandError?: (result: Res) => boolean,
  ): Promise<Res> => {
    // The proxy identity is a required covered field (ADR-0019), so a context
    // without one cannot produce a verifiable event. That is a configuration
    // error rather than a runtime condition: core has stamped `ctx.proxy` on
    // every ProxyContext since 3.0.0, so reaching here without it means a host
    // invoked this middleware with a hand-built context.
    //
    // Handled here, at the pre-call stage alongside subkey derivation, which is
    // the one failure point allowed to fail the call. Throwing after the call
    // would mask the tool result, and substituting a sentinel identity would
    // write a trail that looks attributed and is not, which is the failure
    // #85 and #122 exist to prevent.
    const proxy = ctx.proxy;
    if (proxy === undefined) {
      throw new Error(
        'mcpose/audit: ctx.proxy is required, because the proxy identity is a covered field of every audit event. mcpose core stamps it on every ProxyContext; a host invoking this middleware with its own context must supply it.',
      );
    }
    const identity = ctx.identity ?? anonymousIdentity();
    const sessionId = ctx.sessionId;
    const tool = req.params.name;
    const args = (req.params.arguments as Record<string, unknown>) ?? {};

    if (sessionId && !sessions.has(sessionId)) {
      // First-seen wins: the manifest records the proxy identity of the
      // request that opened the session, and each event still records its own.
      // No backfill branch is needed now that `proxy` is always present.
      sessions.set(sessionId, {
        events: [],
        prevChainHash: '',
        startedAt: new Date().toISOString(),
        identity,
        proxy,
        inflight: new Map(),
      });
    }
    // Admission (#168): registered synchronously, before the first await of
    // this function, and captured once. From here until the `finally` below
    // the call counts as in flight: `closeSession` drains that set before it
    // seals, so the session cannot vanish under a call that is still deriving
    // keys, awaiting the upstream, or persisting its event. Re-resolving the
    // id after an await is what produced position-0 orphans with no manifest.
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const admission = Symbol(tool);
    session?.inflight.set(admission, { tool, requestId: ctx.requestId });

    try {
      // Subkey derivation runs BEFORE the upstream call: if the signing
      // provider is unavailable the call fails fast rather than running
      // unaudited.
      const { chainKey, encRoot } = await deriveSubkeys();
      // Erasable mode (ADR-0018). Fetched at the pre-call stage alongside subkey
      // derivation, for the same reason: without the subject key there is no way
      // to record this event, so the call fails fast rather than running
      // unaudited. Nothing is cached across calls — `destroy` must take effect
      // immediately, and a subject that calls again after erasure gets a fresh
      // key from the store rather than a stale one from here. A rejected fetch
      // therefore leaves no poisoned state and the next call retries.
      //
      // The subject is the RESOLVED identity's `sub`, so anonymous events all
      // land in the `anonymousIdentity()` bucket, which is the designated
      // single bucket the ADR calls for.
      // Written as a ternary rather than `await options.keyStore?.…` so default
      // mode does not even take the extra microtask tick an `await undefined`
      // would cost it.
      const subjectKey = options.keyStore
        ? await options.keyStore.getOrCreate(identity.sub)
        : undefined;
      const startedAt = new Date().toISOString();
      const start = performance.now();

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
      //    must not fail (or mask the failure of) the audited call itself.
      try {
        const rejectionReason = threw ? getRejectionReason(thrown) : undefined;
        // A call can fail without throwing: an MCP tool reports failure
        // in-band with `isError: true` (#171). The caller supplies the
        // predicate, so only tool calls pass one and prompts never match.
        const inBandError = !threw && isInBandError?.(result as Res) === true;
        const outcome: AuditEvent['outcome'] =
          rejectionReason !== undefined
            ? 'rejected'
            : threw || inBandError
              ? 'error'
              : 'success';

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

          const position = session?.events.length ?? 0;
          const event = buildEvent({
            ctx,
            identity,
            proxy,
            kind,
            tool,
            args,
            result: threw ? undefined : result,
            startedAt,
            endedAt: new Date().toISOString(),
            duration_ms: Math.round(performance.now() - start),
            outcome,
            rejectionReason,
            error:
              outcome !== 'error'
                ? undefined
                : threw
                  ? {
                      name: thrown instanceof Error ? thrown.name : 'Error',
                      message:
                        thrown instanceof Error
                          ? thrown.message
                          : String(thrown),
                    }
                  : // A fixed message: `error` is never encrypted, so copying the
                    // tool's own text here would leak a high-tier payload.
                    {
                      name: 'ToolError',
                      message: 'Tool result returned isError: true',
                    },
            position,
            prevChainHash: session?.prevChainHash ?? '',
            tier,
            chainKey,
            encRoot,
            subjectKey,
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
    } finally {
      // Settle after the event is appended and `onEvent` has settled, so a
      // draining close also waits for pending persistence. A pre-call failure
      // lands here too, so a rejected key fetch never leaves the session
      // looking busy.
      if (session) {
        session.inflight.delete(admission);
        if (session.inflight.size === 0) session.onDrained?.();
      }
    }
  };

  // Tool calls: wrapped so `passThroughTools` stay audited. Prompts have no
  // pass-through concept, so the prompt middleware needs no wrapper.
  const inner: AuditMiddlewareHandle['middleware'] = (req, next, ctx) =>
    observe(
      undefined,
      req,
      next,
      ctx,
      (result) => hasToolContent(result) && result.isError === true,
    );
  const middleware = markPassThroughObserver(inner);
  const promptMiddleware: AuditMiddlewareHandle['promptMiddleware'] = (
    req,
    next,
    ctx,
  ) => observe('prompt', req, next, ctx);

  const closeSession: AuditMiddlewareHandle['closeSession'] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) return Promise.resolve(undefined);
    // A close already in progress is the close: joining it is what keeps a
    // DELETE that races a TTL expiry from signing two manifests.
    session.closing ??= sealSession(sessionId, session);
    return session.closing;
  };

  const sealSession = async (
    sessionId: string,
    session: SessionState,
  ): Promise<ReplayManifest | undefined> => {
    // Drain: every admitted call appends its event before it settles, so the
    // manifest sealed below covers them all with continuous positions. The
    // loop re-checks because a call can be admitted while one drain waits.
    // Bounded, because a handler or sink that never settles must not hold
    // the session's already-recorded events unsigned forever: past the
    // deadline the manifest seals what it has and each straggler is reported.
    const deadline = performance.now() + closeDrainTimeoutMs;
    while (session.inflight.size > 0) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        for (const { tool, requestId } of session.inflight.values()) {
          onAuditError(
            new Error(
              `mcpose/audit: closeSession(${sessionId}) sealed after ${closeDrainTimeoutMs} ms with this call still in flight; its event is not in the manifest`,
            ),
            { tool, requestId, sessionId },
          );
        }
        break;
      }
      await new Promise<void>((resolve) => {
        const timer = Number.isFinite(remaining)
          ? setTimeout(resolve, remaining)
          : undefined;
        session.onDrained = () => {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        };
      });
    }
    delete session.onDrained;
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
      proxy: session.proxy,
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

  return { middleware, promptMiddleware, closeSession };
}

/** Rebuilds the exact signed payload for a manifest (used by verifiers). */
export function manifestSigningPayload(
  manifest: Omit<ReplayManifest, 'signature'>,
): string {
  const {
    sessionId,
    identity,
    proxy,
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
      // Required covered field, included unconditionally (ADR-0019). Under
      // the omission pattern a manifest with `proxy` stripped rebuilt the
      // same payload as one that never had it, so the signature could not
      // detect the removal.
      proxy,
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
  /**
   * Narrowed from `ctx.proxy` by the pre-call guard, so this stays total and
   * the required covered field cannot be re-widened here (ADR-0019).
   */
  proxy: ProxyIdentity;
  /** `'prompt'` for a prompts/get event; undefined for a tool call. */
  kind: 'prompt' | undefined;
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
  /**
   * The subject's destroyable key in erasable mode, `undefined` in default
   * mode. Its presence is the ONLY thing that changes derivation, which is
   * what keeps default mode byte-identical (ADR-0018).
   */
  subjectKey: Buffer | undefined;
}

/** Fully synchronous — position allocation relies on that (no await between read and append). */
function buildEvent(p: BuildParams): AuditEvent {
  // Fail CLOSED: only explicit low/medium get plaintext; any other tier
  // value — including garbage from a user-supplied resolver — encrypts.
  // Decided before the preimage is built, because the tier is a covered
  // field and must be the one the event actually ships with (ADR-0015).
  const sensitivityTier =
    p.tier === 'low' || p.tier === 'medium' ? p.tier : 'high';

  // Erasable mode: one subkey off the subject key keys both payload hashes.
  // Derived per event rather than held anywhere, so it dies with the subject
  // key it came from (ADR-0018).
  const hashSubkey =
    p.subjectKey === undefined
      ? undefined
      : createHmac('sha256', p.subjectKey).update(DOMAIN_HASH_KEY).digest();

  const withoutChainHash = {
    id: p.ctx.requestId,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    ...(p.ctx.sessionId !== undefined ? { sessionId: p.ctx.sessionId } : {}),
    ...(p.ctx.delegatedFrom !== undefined
      ? { delegatedFrom: p.ctx.delegatedFrom }
      : {}),
    proxy: p.proxy,
    ...(p.kind !== undefined ? { kind: p.kind } : {}),
    // Optional covered field under the ADR-0012 omission rule, exactly as
    // `kind` is: default-mode events do not carry the key at all, so their
    // preimage is unchanged (ADR-0018).
    ...(p.subjectKey !== undefined ? { erasable: true as const } : {}),
    identity: p.identity,
    tool: p.tool,
    duration_ms: p.duration_ms,
    outcome: p.outcome,
    sensitivityTier,
    ...(p.rejectionReason !== undefined
      ? { rejectionReason: p.rejectionReason }
      : {}),
    ...(p.error !== undefined ? { error: p.error } : {}),
    inputHash: payloadHash(p.args, hashSubkey),
    outputHash: payloadHash(p.result ?? null, hashSubkey),
    replayManifestPosition: p.position,
  };

  const chainHash = computeChainHash(
    chainPreimageFields(withoutChainHash as Omit<AuditEvent, 'chainHash'>),
    p.prevChainHash,
    p.chainKey,
  );

  const base = { ...withoutChainHash, chainHash };

  if (sensitivityTier !== 'high') {
    return {
      ...base,
      sensitivityTier,
      inputRaw: p.args,
      outputRaw: p.result,
    };
  }
  // Erasable mode swaps the ROOT and nothing else: same label, same session,
  // position and event-id inputs, same AES-256-GCM layout and AAD. Only the
  // key's provenance changes, from the pure-derived `encRoot` to the stored,
  // destroyable subject key (ADR-0018).
  const eventKey = deriveEventKey(
    p.subjectKey ?? p.encRoot,
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
