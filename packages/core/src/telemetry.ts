import type { Identity } from './identity.js';
import type { ProxyIdentity } from './proxyContext.js';
import type { RejectionReason } from './rejection.js';

/** Emitted after every tool call (success, error, or rejection). */
export interface ToolCallTelemetryEvent {
  type: 'tool_call';
  requestId: string;
  sessionId?: string;
  tool: string;
  duration_ms: number;
  outcome: 'success' | 'error' | 'rejected';
  /** Populated when `outcome` is `'rejected'`. */
  rejectionReason?: RejectionReason;
  identity?: Identity;
  /** The proxy instance that handled the call (ADR-0012). */
  proxy?: ProxyIdentity;
}

/**
 * Emitted when one backend of a mesh fails a list call and the proxy
 * returns the remaining backends' entries instead of failing the whole
 * list (ADR-0013). Without an `onTelemetry` sink a degraded mesh is
 * invisible, so an operator running one should wire it.
 */
export interface BackendDegradedTelemetryEvent {
  type: 'backend_degraded';
  requestId: string;
  sessionId?: string;
  /** The backend key whose entries are missing from the response. */
  backend: string;
  /** The list call that degraded. */
  method: 'tools/list' | 'prompts/list';
  /** Whatever the backend threw. */
  error: unknown;
  identity?: Identity;
  /** The proxy instance that handled the call (ADR-0012). */
  proxy?: ProxyIdentity;
}

/**
 * An observability signal from the proxy, discriminated on `type`. Narrow
 * on it before reading a member's own fields.
 */
export type TelemetryEvent =
  ToolCallTelemetryEvent | BackendDegradedTelemetryEvent;
