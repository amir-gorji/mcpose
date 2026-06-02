import { createCipheriv, randomBytes, createHash } from 'node:crypto';
import type {
  AuditEvent,
  AuditMiddlewareHandle,
  AuditOptions,
  HighAuditEvent,
  LowAuditEvent,
  MediumAuditEvent,
  ReplayManifest,
} from './types.js';
import { computeChainHash, computeMerkleProof, computeMerkleRoot, sha256hex } from './chain.js';
import type { Identity, ProxyContext } from 'mcpose';

interface SessionState {
  events: AuditEvent[];
  prevChainHash: string;
  startedAt: string;
  identity: Identity;
}

function aesEncrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.subarray(0, 32), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function deriveEventKey(chainKey: Buffer, eventId: string): Buffer {
  return createHash('sha256').update(chainKey).update(eventId).digest();
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

export function createAuditMiddleware(options: AuditOptions): AuditMiddlewareHandle {
  const sessions = new Map<string, SessionState>();

  // Derive a stable 32-byte key from the signingKey.keyId (SHA-256 hex of the secret).
  // Used for HMAC chain hashes (synchronous) and per-event AES-256 encryption.
  // The async sign() on signingKey is reserved for signing the ReplayManifest root.
  const chainKey = Buffer.from(options.signingKey.keyId, 'hex');

  const middleware: AuditMiddlewareHandle['middleware'] = async (req, next, ctx) => {
    const start = Date.now();
    const identity = ctx.identity ?? anonymousIdentity();
    const sessionId = ctx.sessionId;

    if (sessionId && !sessions.has(sessionId)) {
      sessions.set(sessionId, {
        events: [],
        prevChainHash: '',
        startedAt: new Date().toISOString(),
        identity,
      });
    }

    const session = sessionId ? sessions.get(sessionId) : undefined;
    const position = session?.events.length ?? 0;
    const tool = req.params.name;
    const args = (req.params.arguments as Record<string, unknown>) ?? {};
    const tier = options.sensitivityResolver(tool, identity, args);

    let outcome: AuditEvent['outcome'] = 'success';
    let result: unknown;
    let threw = false;

    try {
      result = await next(req);
    } catch (err) {
      outcome = 'error';
      threw = true;
      result = undefined;
      const event = buildEvent({
        ctx, identity, tool, args, result: undefined,
        duration_ms: Date.now() - start, outcome, position,
        prevChainHash: session?.prevChainHash ?? '',
        tier, chainKey,
      });
      advanceSession(session, event);
      await options.onEvent(event);
      throw err;
    }

    if (!threw) {
      const event = buildEvent({
        ctx, identity, tool, args, result,
        duration_ms: Date.now() - start, outcome, position,
        prevChainHash: session?.prevChainHash ?? '',
        tier, chainKey,
      });
      advanceSession(session, event);
      await options.onEvent(event);
    }

    return result as Awaited<ReturnType<typeof next>>;
  };

  const closeSession: AuditMiddlewareHandle['closeSession'] = async (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session || session.events.length === 0) return undefined;

    sessions.delete(sessionId);

    const hashes = session.events.map((e) => e.chainHash);
    const merkleRoot = computeMerkleRoot(hashes);
    const merkleProofs = hashes.map((_, i) => computeMerkleProof(hashes, i));
    const signature = (await options.signingKey.sign(Buffer.from(merkleRoot))).toString('hex');

    const manifest: ReplayManifest = {
      sessionId,
      identity: session.identity,
      startedAt: session.startedAt,
      closedAt: new Date().toISOString(),
      eventCount: session.events.length,
      merkleRoot,
      merkleProofs,
      signedBy: options.signingKey.keyId,
      signature,
    };

    await options.onManifest?.(manifest);
    return manifest;
  };

  return { middleware, closeSession };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function advanceSession(session: SessionState | undefined, event: AuditEvent): void {
  if (!session) return;
  session.events.push(event);
  session.prevChainHash = event.chainHash;
}

interface BuildParams {
  ctx: ProxyContext;
  identity: Identity;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  duration_ms: number;
  outcome: AuditEvent['outcome'];
  position: number;
  prevChainHash: string;
  tier: 'low' | 'medium' | 'high';
  chainKey: Buffer;
}

function buildEvent(p: BuildParams): AuditEvent {
  const stableFields = {
    id: p.ctx.requestId,
    timestamp: new Date().toISOString(),
    ...(p.ctx.sessionId !== undefined ? { sessionId: p.ctx.sessionId } : {}),
    ...(p.ctx.delegatedFrom !== undefined ? { delegatedFrom: p.ctx.delegatedFrom } : {}),
    identity: p.identity,
    tool: p.tool,
    duration_ms: p.duration_ms,
    outcome: p.outcome,
    inputHash: sha256hex(JSON.stringify(p.args)),
    outputHash: sha256hex(JSON.stringify(p.result ?? null)),
    replayManifestPosition: p.position,
  };

  const chainHash = computeChainHash(stableFields, p.prevChainHash, p.chainKey);

  const base = { ...stableFields, chainHash };

  if (p.tier === 'high') {
    const eventKey = deriveEventKey(p.chainKey, base.id);
    return {
      ...base,
      sensitivityTier: 'high',
      inputEncrypted: aesEncrypt(JSON.stringify(p.args), eventKey),
      outputEncrypted: aesEncrypt(JSON.stringify(p.result ?? null), eventKey),
    } as HighAuditEvent;
  }
  if (p.tier === 'medium') {
    return { ...base, sensitivityTier: 'medium', inputRaw: p.args, outputRaw: p.result } as MediumAuditEvent;
  }
  return { ...base, sensitivityTier: 'low', inputRaw: p.args, outputRaw: p.result } as LowAuditEvent;
}
