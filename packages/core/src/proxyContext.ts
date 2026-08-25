import { randomUUID } from 'node:crypto';
import type { Identity } from './identity.js';

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
  /** @experimental Reserved for the v3 policy engine — do not depend on it. */
  policy?: never;
}

/** Creates a middleware context with a fresh request ID. */
export function createProxyContext(
  overrides: Partial<ProxyContext> = {},
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
  };
}
