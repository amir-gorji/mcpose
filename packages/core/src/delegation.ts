/**
 * The delegation chain wire format: how a chain crosses the wire in
 * `params._meta` and how it is read back (ADR-0016).
 *
 * The chain is attribution, never authorization. A presented chain is
 * written by the previous hop and is attacker-influenced at the boundary,
 * so `roles` and `claims` never travel on the wire and are never taken
 * from one: extraction produces identities with empty roles and claims,
 * unconditionally.
 */
import { ErrorCode, type McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Identity } from './identity.js';
import { outboundDelegationChain, type ProxyContext } from './proxyContext.js';
import { rejectionMcpError } from './rejection.js';

/**
 * The `params._meta` key carrying the delegation chain. Exported so a host
 * attaching {@link outboundDelegationChain} to its own outbound MCP calls
 * uses the same key core does.
 */
// A public wire constant, not a credential: the trailing allow keeps
// gitleaks' generic-api-key rule from matching the `_KEY` name.
export const DELEGATION_META_KEY = 'mcpose/delegation'; // gitleaks:allow

/** The only wire version this proxy parses or emits. */
const WIRE_VERSION = 1;

/**
 * Parse bound on a presented chain, not the hop-count policy knob ADR-0011
 * rejected: it constrains what this proxy will parse, not what host
 * outbound code does.
 */
const MAX_CHAIN_ENTRIES = 32;

const IDENTITY_TYPES = ['human', 'agent', 'service'] as const;
const IDENTITY_SOURCES = ['jwt', 'mtls', 'apikey', 'custom'] as const;

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** One entry of the wire chain: no `roles`, no `claims`, ever. */
export interface DelegationWireEntry {
  sub: string;
  type: Identity['type'];
  displayName?: string;
  resolvedAt?: string;
  source?: Identity['source'];
}

/** The versioned payload carried at `params._meta["mcpose/delegation"]`. */
export interface DelegationWirePayload {
  v: number;
  chain: DelegationWireEntry[];
}

/** What reading the inbound payload produced. Both fields absent means "no chain". */
export interface InboundDelegation {
  /** The presented chain, oldest-first. Absent when there was none. */
  chain?: Identity[];
  /**
   * The rejection a malformed payload earned. Thrown inside the pipeline by
   * the caller, so observing middleware records the attempt.
   */
  error?: McpError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_8601.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function rejection(detail: string): McpError {
  return rejectionMcpError(
    'DELEGATION_INVALID',
    ErrorCode.InvalidRequest,
    `Invalid delegation chain: ${detail}`,
  );
}

function invalid(detail: string): InboundDelegation {
  return { error: rejection(detail) };
}

/**
 * Serializes a chain to its wire payload, dropping `roles` and `claims`.
 *
 * Exported for hosts that attach {@link outboundDelegationChain} to their own
 * outbound MCP calls from a local tool handler, which ADR-0011 leaves to the
 * host because outbound host code may not be MCP at all.
 */
export function serializeDelegationChain(
  chain: ReadonlyArray<Identity>,
): DelegationWirePayload {
  return {
    v: WIRE_VERSION,
    chain: chain.map((identity) => ({
      sub: identity.sub,
      type: identity.type,
      ...(identity.displayName === undefined
        ? {}
        : { displayName: identity.displayName }),
      resolvedAt: identity.resolvedAt,
      source: identity.source,
    })),
  };
}

/**
 * Reads the chain from a raw request, before the ADR-0008 request-`_meta`
 * strip runs: read first, strip second, or the marker never survives a
 * chained proxy (the ADR-0011 boundary-ordering constraint).
 *
 * An absent payload is not an error. A present-but-malformed one is, and is
 * returned rather than thrown so the caller can throw it inside the pipeline.
 */
export function readInboundDelegation(req: {
  params?: { _meta?: unknown } | undefined;
}): InboundDelegation {
  const meta = req.params?._meta;
  const payload = isRecord(meta) ? meta[DELEGATION_META_KEY] : undefined;
  if (payload === undefined) return {};
  if (!isRecord(payload)) return invalid('payload is not an object');
  if (payload.v !== WIRE_VERSION) {
    return invalid(`unsupported version ${JSON.stringify(payload.v)}`);
  }
  const wireChain = payload.chain;
  if (!Array.isArray(wireChain)) return invalid('chain is not an array');
  if (wireChain.length > MAX_CHAIN_ENTRIES) {
    return invalid(`chain exceeds ${MAX_CHAIN_ENTRIES} entries`);
  }

  const receivedAt = new Date().toISOString();
  const chain: Identity[] = [];
  for (const entry of wireChain as unknown[]) {
    if (!isRecord(entry)) return invalid('an entry is not an object');
    const { sub, type } = entry;
    if (typeof sub !== 'string' || sub === '') {
      return invalid('an entry has no sub');
    }
    if (!IDENTITY_TYPES.includes(type as Identity['type'])) {
      return invalid(`entry ${JSON.stringify(sub)} has an unknown type`);
    }
    chain.push({
      sub,
      type: type as Identity['type'],
      ...(typeof entry.displayName === 'string'
        ? { displayName: entry.displayName }
        : {}),
      // Attribution, never authorization: whatever the wire claimed here is
      // discarded, so a presented chain cannot smuggle a privilege.
      roles: [],
      claims: {},
      resolvedAt: isIsoTimestamp(entry.resolvedAt)
        ? entry.resolvedAt
        : receivedAt,
      source: IDENTITY_SOURCES.includes(entry.source as Identity['source'])
        ? (entry.source as Identity['source'])
        : 'custom',
    });
  }
  // An empty presented chain says the same thing as no chain at all, and
  // leaving `delegatedFrom` unset keeps it either absent or non-empty.
  return chain.length === 0 ? {} : { chain };
}

/**
 * Detects a chain that loops back through this proxy: the sub of the identity
 * it resolved for the caller already appears in the chain that caller
 * presents, so the call has cycled (ADR-0016).
 *
 * Runs after identity resolution and returns the rejection rather than
 * throwing it, so the caller throws it inside the pipeline and the audit
 * trail records the attempt against the identity that tripped it.
 *
 * With no resolved identity there is nothing to look for, which is the stdio
 * case: only the structural validation in {@link readInboundDelegation}
 * applies there. Core sees only the calls it forwards itself, so a cycle that
 * closes through a local tool handler's own outbound call is outside this
 * check, exactly as ADR-0011 said a partial control must admit.
 */
export function detectDelegationLoop(
  context: ProxyContext,
): McpError | undefined {
  const sub = context.identity?.sub;
  if (sub === undefined) return undefined;
  const looped = (context.delegatedFrom ?? []).some(
    (entry) => entry.sub === sub,
  );
  return looped
    ? rejection(`the caller ${JSON.stringify(sub)} is already in the chain`)
    : undefined;
}

/**
 * Attaches the chain this proxy can vouch for to a forwarded request's
 * params, closing the loop for a chained proxy: the inbound strip removes
 * the caller's copy, and core re-attaches the extended chain (ADR-0016).
 *
 * A no-op when the outbound chain is empty, so a proxy with no identity and
 * no inbound chain forwards params untouched.
 */
export function attachDelegationMeta<P>(params: P, context: ProxyContext): P {
  const chain = outboundDelegationChain(context);
  if (chain.length === 0) return params;
  const existing = (params as { _meta?: Record<string, unknown> } | undefined)
    ?._meta;
  // P is inferred from the call site, so the result is exactly the params
  // shape the callee expects, plus a `_meta` every request type allows —
  // which the compiler cannot prove for an unresolved generic.
  return {
    ...params,
    _meta: {
      ...existing,
      [DELEGATION_META_KEY]: serializeDelegationChain(chain),
    },
  };
}
