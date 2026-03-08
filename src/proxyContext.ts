import { randomUUID } from 'node:crypto';

/** Normalized request metadata that mcpose passes through middleware layers. */
export interface ProxyContext {
  requestId: string;
  transport: 'stdio' | 'http';
  sessionId?: string;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

/** Creates a middleware context with a fresh request ID. */
export function createProxyContext(
  overrides: Partial<ProxyContext> = {},
): ProxyContext {
  return {
    requestId: overrides.requestId ?? randomUUID(),
    transport: overrides.transport ?? 'stdio',
    ...(overrides.sessionId === undefined
      ? {}
      : { sessionId: overrides.sessionId }),
    ...(overrides.headers === undefined ? {} : { headers: overrides.headers }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}
