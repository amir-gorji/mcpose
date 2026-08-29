import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * Structured reason for a rejected call.
 *
 * Placed in the MCP error `data` field — the top-level error code is
 * unchanged (`MethodNotFound` / `InvalidRequest`) so existing clients are
 * unaffected. Agents and audit middleware can inspect `error.data.rejectionReason`
 * for programmatic handling and compliance logging.
 *
 * @stable
 */
export type RejectionReason =
  | 'TOOL_HIDDEN' // tool exists but is hidden from this caller
  | 'RESOURCE_HIDDEN' // resource exists but is hidden from this caller
  | 'BACKEND_UNROUTABLE' // mesh mode: name carries no `<backendKey>__` prefix naming a configured backend
  | 'POLICY_DENIED' // @mcpose/policy: a rule denied, or no rule allowed (ADR-0017)
  | 'IDENTITY_UNRESOLVED' // identity could not be established; @mcpose/policy is its first emitter (ADR-0017)
  | 'CONSENT_MISSING' // v3: GDPR/CCPA consent gate blocked the call
  | 'SENSITIVITY_BLOCKED' // @mcpose/policy: a sensitivity-tier rule blocked the call (ADR-0017)
  | 'DELEGATION_INVALID' // v3: agent delegation chain is invalid or expired
  | 'BUDGET_EXCEEDED' // @mcpose/policy: the per-session call budget is exhausted (ADR-0017)
  | 'SESSION_LIMIT' // max concurrent sessions reached (HTTP 503)
  | 'BODY_LIMIT'; // request body exceeded maxBodyBytes (HTTP 413)

/**
 * Creates an `McpError` with the rejection reason embedded in `error.data`.
 * The top-level `code` is unchanged so clients that only inspect the code
 * are unaffected.
 */
export function rejectionMcpError(
  reason: RejectionReason,
  code: ErrorCode,
  message: string,
): McpError {
  return new McpError(code, message, { rejectionReason: reason });
}
