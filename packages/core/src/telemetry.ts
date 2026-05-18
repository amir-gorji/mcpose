import type { Identity } from './identity.js';
import type { RejectionReason } from './rejection.js';

/** Emitted after every tool call (success, error, or rejection). */
export interface TelemetryEvent {
  type: 'tool_call';
  requestId: string;
  sessionId?: string;
  tool: string;
  duration_ms: number;
  outcome: 'success' | 'error' | 'rejected';
  /** Populated when `outcome` is `'rejected'`. */
  rejectionReason?: RejectionReason;
  identity?: Identity;
}
