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
  | 'TOOL_HIDDEN'          // tool exists but is hidden from this caller
  | 'RESOURCE_HIDDEN'      // resource exists but is hidden from this caller
  | 'POLICY_DENIED'        // v3: RBAC policy blocked the call
  | 'IDENTITY_UNRESOLVED'  // v3: identity could not be established
  | 'CONSENT_MISSING'      // v3: GDPR/CCPA consent gate blocked the call
  | 'SENSITIVITY_BLOCKED'  // v3: data sensitivity policy blocked the call
  | 'DELEGATION_INVALID'   // v3: agent delegation chain is invalid or expired
  | 'BUDGET_EXCEEDED'      // v3: cost budget for this session/user exceeded
  | 'SESSION_LIMIT'        // max concurrent sessions reached (HTTP 503)
  | 'BODY_LIMIT';          // request body exceeded maxBodyBytes (HTTP 413)

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
