import { randomUUID } from 'node:crypto';
import type { Identity } from './identity.js';

/**
 * The proxy instance a request passed through, as resolved from
 * `ProxyOptions.name`/`version` (defaults included). Provenance, not a
 * principal: it is never an entry in `delegatedFrom` and takes no part in
 * the caller-attribution model (ADR-0011, ADR-0012).
 */
export interface ProxyIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * A policy decision already made, stamped on the context by the policy
 * middleware (ADR-0017). It is a record, not a handle to query: core never
 * evaluates policy itself, and a second evaluation path would let inner
 * middleware ask a different question than the gate answered.
 *
 * `reason` carries the `RejectionReason` that accompanied a denial.
 */
export interface PolicyDecision {
  readonly decision: 'allow' | 'deny';
  readonly ruleId?: string;
  readonly reason?: string;
}

/** Normalized request metadata that mcpose passes through middleware layers. */
export interface ProxyContext {
  requestId: string;
  transport: 'stdio' | 'http';
  sessionId?: string;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** Resolved caller identity. Present when {@link HttpProxyOptions.resolveIdentity} is configured. */
  identity?: Identity;
  /**
   * Agent delegation chain, oldest-first. Populated from the inbound
   * request's `_meta["mcpose/delegation"]` when a caller presents one
   * (ADR-0016), or by a host that stamps its own, which wins.
   *
   * Attribution, never authorization: every entry extracted from the wire
   * carries empty `roles` and `claims`, because a presented chain is written
   * by the previous hop.
   */
  delegatedFrom?: Identity[];
  /** The proxy instance handling this request. Stamped by {@link createProxyServer}. */
  proxy?: ProxyIdentity;
  /**
   * The policy decision for this call. Stamped by the `@mcpose/policy`
   * middleware before it calls `next` (allow) or throws (deny), so
   * middleware running inside the policy layer can rely on
   * `decision: 'allow'` (ADR-0017). Core never writes it.
   */
  policy?: PolicyDecision;
}

/**
 * Canonical oldest-first delegation chain a host attaches to outbound calls
 * made on behalf of the inbound caller (ADR-0011). Returns a fresh array and
 * never mutates or aliases `ctx.delegatedFrom`, because the audit middleware
 * reads the same context object when recording the inbound call.
 *
 * Core attaches this chain itself to every call it forwards to a backend, at
 * `params._meta["mcpose/delegation"]` (ADR-0016). A local tool handler makes
 * its own outbound calls, so its host attaches the chain: for an outbound MCP
 * call, `serializeDelegationChain(outboundDelegationChain(context))` under
 * `DELEGATION_META_KEY` produces exactly what core sends.
 */
export function outboundDelegationChain(ctx: ProxyContext): Identity[] {
  return [
    ...(ctx.delegatedFrom ?? []),
    ...(ctx.identity === undefined ? [] : [ctx.identity]),
  ];
}

/**
 * Creates a middleware context with a fresh request ID.
 *
 * Every override may be passed explicitly as `undefined` — it means "not
 * provided" and the key is dropped from the result, which is why the
 * parameter is not a plain `Partial<ProxyContext>` under
 * `exactOptionalPropertyTypes`.
 */
export function createProxyContext(
  overrides: { [K in keyof ProxyContext]?: ProxyContext[K] | undefined } = {},
): ProxyContext {
  return {
    // Deliberately `||`, not `??`: an empty-string requestId is useless for
    // correlation, so it is regenerated like a missing one.
    requestId: overrides.requestId || randomUUID(),
    transport: overrides.transport ?? 'stdio',
    ...(overrides.sessionId === undefined
      ? {}
      : { sessionId: overrides.sessionId }),
    ...(overrides.headers === undefined ? {} : { headers: overrides.headers }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.identity === undefined
      ? {}
      : { identity: overrides.identity }),
    ...(overrides.delegatedFrom === undefined
      ? {}
      : { delegatedFrom: overrides.delegatedFrom }),
    ...(overrides.proxy === undefined ? {} : { proxy: overrides.proxy }),
    ...(overrides.policy === undefined ? {} : { policy: overrides.policy }),
  };
}
