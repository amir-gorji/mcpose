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

/** Normalized request metadata that mcpose passes through middleware layers. */
export interface ProxyContext {
  requestId: string;
  transport: 'stdio' | 'http';
  sessionId?: string;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** Resolved caller identity. Present when {@link HttpProxyOptions.resolveIdentity} is configured. */
  identity?: Identity;
  /** Agent delegation chain — populated when an upstream A2A agent delegates through mcpose. */
  delegatedFrom?: Identity[];
  /** The proxy instance handling this request. Stamped by {@link createProxyServer}. */
  proxy?: ProxyIdentity;
  /** @experimental Reserved for the v3 policy engine — do not depend on it. */
  policy?: never;
}

/**
 * Canonical oldest-first delegation chain a host attaches to outbound calls
 * made on behalf of the inbound caller (ADR-0011). Returns a fresh array and
 * never mutates or aliases `ctx.delegatedFrom`, because the audit middleware
 * reads the same context object when recording the inbound call.
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
  };
}
