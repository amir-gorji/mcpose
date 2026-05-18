/** Who made the request — resolved once per session via {@link resolveIdentity}. */
export interface Identity {
  /** Stable unique identifier (e.g. OIDC `sub` claim). */
  sub: string;
  /** Whether the caller is a human user, an AI agent, or an automated service. */
  type: 'human' | 'agent' | 'service';
  displayName?: string;
  roles: string[];
  /** Arbitrary claims from the resolved identity source (JWT payload, cert CN, etc.). */
  claims: Record<string, unknown>;
  /** ISO 8601 timestamp of when identity was resolved. */
  resolvedAt: string;
  /** Which resolver produced this identity. */
  source: 'jwt' | 'mtls' | 'apikey' | 'custom';
}
