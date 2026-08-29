import { rejectionMcpError } from 'mcpose';
import type {
  Identity,
  PromptMiddleware,
  ProxyContext,
  ToolMiddleware,
} from 'mcpose';

/**
 * `ErrorCode.InvalidRequest` (-32600) without depending on
 * `@modelcontextprotocol/sdk`: the enum member is read off the public
 * signature of `rejectionMcpError`, so this package keeps `mcpose` as its
 * only peer.
 */
const INVALID_REQUEST = -32600 as Parameters<typeof rejectionMcpError>[1];

/**
 * Answers whether this caller has consented to this tool or prompt.
 *
 * Host-provided and allowed to be async, because consent is external state
 * the host owns: a row in a database, a call to a consent platform, a cached
 * grant. That is the deliberate contrast with `@mcpose/policy`, whose
 * evaluation is pure and synchronous by ADR-0017 — a policy rule set is
 * compiled ahead of time, while a consent grant is looked up (ADR-0018).
 *
 * Return `true` to allow. Anything else, including a rejected promise, blocks
 * the call: this gate fails closed in every direction.
 */
export type ResolveConsentFn = (
  identity: Identity,
  toolName: string,
) => boolean | Promise<boolean>;

export interface ConsentOptions {
  readonly resolveConsent: ResolveConsentFn;
  /**
   * Called when `resolveConsent` throws or rejects, with the thrown value and
   * the call it was blocking. The call is refused either way; this exists so
   * a broken consent source is visible to operators instead of being
   * indistinguishable from a caller who simply has not consented.
   * @default console.error
   */
  readonly onResolverError?: (
    err: unknown,
    info: { readonly subject: string; readonly name: string },
  ) => void;
}

export interface ConsentMiddlewareHandle {
  /** Gates `tools/call`. Wire it into `ProxyOptions.toolMiddleware`. */
  middleware: ToolMiddleware;
  /** Gates `prompts/get` through the same resolver, on the prompt name. */
  promptMiddleware: PromptMiddleware;
}

/** What the consent gate needs from a call: tool calls and prompt fetches both carry a name. */
interface NamedRequest {
  params: { name: string };
}

/**
 * Builds the consent gate described by [ADR-0018](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0018-cryptographic-erasure-and-the-chain.md).
 *
 * One question, asked before every gated call: has this caller consented to
 * this tool? The answer comes from the host's `resolveConsent`, and the gate
 * refuses the call on anything but an unambiguous yes:
 *
 * - No resolved `ctx.identity`. There is no subject whose consent could be
 *   checked, so there is no consent.
 * - The resolver returns anything but `true`.
 * - The resolver throws or rejects. A consent source that is down is not a
 *   grant; treating an outage as permission is the one failure mode a consent
 *   gate must not have.
 *
 * Every refusal is a `CONSENT_MISSING` rejection thrown from inside the
 * pipeline, so audit middleware composed OUTSIDE this one records it as a
 * rejected call carrying that reason. Compose it as
 * `toolMiddleware: [audit.middleware, consent.middleware]`.
 *
 * What counts as consent — its granularity, its expiry, how withdrawal is
 * recorded — is entirely the host's. This package is the enforcement point,
 * not the definition.
 */
export function createConsentMiddleware(
  options: ConsentOptions,
): ConsentMiddlewareHandle {
  const onResolverError =
    options.onResolverError ?? ((err: unknown) => console.error(err));

  const gate = async <Req extends NamedRequest, Res>(
    req: Req,
    next: (req: Req) => Promise<Res>,
    ctx: ProxyContext,
  ): Promise<Res> => {
    const name = req.params.name;
    const identity = ctx.identity;

    if (identity === undefined) {
      throw rejectionMcpError(
        'CONSENT_MISSING',
        INVALID_REQUEST,
        `No identity resolved, so no consent could be established for ${name}`,
      );
    }

    let granted: boolean;
    try {
      granted = await options.resolveConsent(identity, name);
    } catch (err) {
      // Report, then refuse. The caller is told only that consent is missing:
      // the resolver's failure detail is an internal fact about the host's
      // consent source, not something a client asked about.
      onResolverError(err, { subject: identity.sub, name });
      throw rejectionMcpError(
        'CONSENT_MISSING',
        INVALID_REQUEST,
        `Consent for ${name} could not be established`,
      );
    }

    // Strict `!== true`, not falsiness: a resolver that returns a non-boolean
    // from an untyped host must not be read as a grant.
    if (granted !== true) {
      throw rejectionMcpError(
        'CONSENT_MISSING',
        INVALID_REQUEST,
        `${identity.sub} has not consented to ${name}`,
      );
    }

    return next(req);
  };

  return {
    middleware: (req, next, ctx) => gate(req, next, ctx),
    promptMiddleware: (req, next, ctx) => gate(req, next, ctx),
  };
}
