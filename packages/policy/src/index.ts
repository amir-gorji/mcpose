import { rejectionMcpError } from 'mcpose';
import type {
  Identity,
  PolicyDecision,
  PromptMiddleware,
  ProxyContext,
  RejectionReason,
  ToolMiddleware,
} from 'mcpose';

/**
 * `ErrorCode.InvalidRequest` (-32600) without depending on
 * `@modelcontextprotocol/sdk`: the enum member is read off the public
 * signature of `rejectionMcpError`, so this package keeps `mcpose` as its
 * only peer.
 */
const INVALID_REQUEST = -32600 as Parameters<typeof rejectionMcpError>[1];

/** Data sensitivity tier. Structurally identical to the audit package's tier. */
export type SensitivityTier = 'low' | 'medium' | 'high';

/**
 * One RBAC rule. A rule matches a call when the caller holds at least one
 * of `roles` (or `roles` is `'*'`) and the tool or prompt name is listed in
 * `tools` (or `tools` is `'*'`).
 *
 * An explicit `deny` beats every `allow`; with no rule matching at all the
 * call is denied, because the engine is deny-by-default (ADR-0017).
 */
export interface PolicyRule {
  readonly id: string;
  readonly effect: 'allow' | 'deny';
  readonly roles: ReadonlyArray<string> | '*';
  readonly tools: ReadonlyArray<string> | '*';
}

/**
 * Blocks a set of sensitivity tiers for a set of roles. Evaluated after the
 * RBAC rules allow the call, so a tier rule can only subtract access.
 */
export interface SensitivityRule {
  readonly roles: ReadonlyArray<string> | '*';
  readonly deniedTiers: ReadonlyArray<SensitivityTier>;
}

export interface PolicyOptions {
  /** The rule set. An empty set denies everything. */
  readonly rules: ReadonlyArray<PolicyRule>;
  /**
   * Tier rules. Omit them and sensitivity is not consulted at all; supply
   * one and every name missing from `sensitivity` counts as `'high'`.
   */
  readonly sensitivityRules?: ReadonlyArray<SensitivityRule>;
  /**
   * Name-to-tier classification, in the same shape
   * `createSensitivityResolver` from `@mcpose/audit` accepts, so one
   * classification feeds both encryption and blocking. Unmapped names
   * resolve to `'high'`, fail-closed, exactly as the audit resolver does.
   */
  readonly sensitivity?: Record<string, SensitivityTier>;
  /**
   * Per-session call budget. Counters live in memory on this middleware
   * instance and are keyed by `ctx.sessionId`; a call without a session id
   * is never counted and never blocked.
   */
  readonly budget?: { readonly maxCallsPerSession: number };
}

export interface PolicyMiddlewareHandle {
  /** Gates `tools/call`. Wire it into `ProxyOptions.toolMiddleware`. */
  middleware: ToolMiddleware;
  /**
   * Gates `prompts/get` against the same rule set, budget, and counters —
   * a prompt name is matched exactly as a tool name is.
   */
  promptMiddleware: PromptMiddleware;
}

/** What the policy layer needs from a gated request: tool calls and prompt fetches both carry a name. */
interface NamedRequest {
  params: { name: string };
}

const TIERS: ReadonlySet<string> = new Set<SensitivityTier>([
  'low',
  'medium',
  'high',
]);

/**
 * Fail CLOSED: anything that is not a known tier is treated as `'high'`,
 * which guards against typos in the classification map. Mirrors
 * `createSensitivityResolver`.
 */
function resolveTier(
  sensitivity: Record<string, SensitivityTier> | undefined,
  name: string,
): SensitivityTier {
  // `Object.hasOwn`, not `in`: tool names are attacker-controlled, so a tool
  // called `toString` must not inherit a tier off the prototype.
  const raw =
    sensitivity && Object.hasOwn(sensitivity, name)
      ? sensitivity[name]
      : undefined;
  return TIERS.has(raw as string) ? (raw as SensitivityTier) : 'high';
}

function rolesMatch(
  ruleRoles: ReadonlyArray<string> | '*',
  callerRoles: ReadonlyArray<string>,
): boolean {
  return ruleRoles === '*' || ruleRoles.some((r) => callerRoles.includes(r));
}

function namesMatch(
  ruleTools: ReadonlyArray<string> | '*',
  name: string,
): boolean {
  return ruleTools === '*' || ruleTools.includes(name);
}

/** A denial: the reason the caller sees and the rule that produced it, if any. */
interface Denial {
  readonly reason: RejectionReason;
  readonly ruleId?: string;
  readonly message: string;
}

/**
 * Stamps the deny decision, then throws. Stamping first is what lets audit
 * middleware composed outside the policy layer see why the call was refused.
 */
function reject(ctx: ProxyContext, denial: Denial): never {
  ctx.policy = Object.freeze<PolicyDecision>({
    decision: 'deny',
    ...(denial.ruleId === undefined ? {} : { ruleId: denial.ruleId }),
    reason: denial.reason,
  });
  throw rejectionMcpError(denial.reason, INVALID_REQUEST, denial.message);
}

/**
 * Builds the deny-by-default policy middleware described by ADR-0017.
 *
 * Evaluation is a pure, synchronous function of the rules, the resolved
 * identity, and the request name. There is no I/O and no remote decision
 * point in the call path: a host with an external policy source compiles it
 * into `rules` ahead of time.
 *
 * The three gates run in this order, so the most specific reason wins and a
 * rejected call never spends budget:
 *
 * 1. RBAC rules — `POLICY_DENIED`, or `IDENTITY_UNRESOLVED` when the only
 *    rules that could have allowed the call require roles and there is no
 *    `ctx.identity`.
 * 2. Sensitivity tier rules — `SENSITIVITY_BLOCKED`.
 * 3. Per-session call budget — `BUDGET_EXCEEDED`.
 *
 * Either way `ctx.policy` is stamped with a frozen {@link PolicyDecision}
 * before the middleware calls `next` or throws, so audit middleware composed
 * *outside* this one records the denial and its reason (ADR-0002 ordering,
 * see the README).
 */
export function createPolicyMiddleware(
  options: PolicyOptions,
): PolicyMiddlewareHandle {
  // Per-instance, per-session call counts. Keyed by ctx.sessionId, so the
  // bounded session lifecycle of the host (#107) bounds this map; two
  // middleware instances never share a budget.
  const callCounts = new Map<string, number>();
  const max = options.budget?.maxCallsPerSession;

  /** Returns the denial, or undefined when the call is allowed. */
  const evaluate = (
    name: string,
    identity: Identity | undefined,
  ): Denial | { readonly ruleId: string } => {
    const roles = identity?.roles ?? [];
    const applies = (rule: PolicyRule) =>
      rolesMatch(rule.roles, roles) && namesMatch(rule.tools, name);

    const denied = options.rules.find((r) => r.effect === 'deny' && applies(r));
    if (denied) {
      return {
        reason: 'POLICY_DENIED',
        ruleId: denied.id,
        message: `Policy rule ${denied.id} denies ${name}`,
      };
    }

    const allowed = options.rules.find(
      (r) => r.effect === 'allow' && applies(r),
    );
    if (!allowed) {
      // An anonymous caller that would have matched a role-gated allow rule
      // is missing an identity, not out of policy. ADR-0017 names the engine
      // the first emitter of IDENTITY_UNRESOLVED, not its owner.
      const needsIdentity =
        identity === undefined &&
        options.rules.some(
          (r) =>
            r.effect === 'allow' &&
            r.roles !== '*' &&
            namesMatch(r.tools, name),
        );
      return needsIdentity
        ? {
            reason: 'IDENTITY_UNRESOLVED',
            message: `No identity resolved, and every rule allowing ${name} requires a role`,
          }
        : {
            reason: 'POLICY_DENIED',
            message: `No policy rule allows ${name}`,
          };
    }

    if (options.sensitivityRules) {
      const tier = resolveTier(options.sensitivity, name);
      const blocked = options.sensitivityRules.some(
        (r) => rolesMatch(r.roles, roles) && r.deniedTiers.includes(tier),
      );
      if (blocked) {
        return {
          reason: 'SENSITIVITY_BLOCKED',
          ruleId: allowed.id,
          message: `Sensitivity tier ${tier} is blocked for this caller on ${name}`,
        };
      }
    }

    return { ruleId: allowed.id };
  };

  const spendBudget = (
    sessionId: string | undefined,
    name: string,
  ): Denial | undefined => {
    // Sessionless calls (stdio without a session id) are uncounted: there is
    // no key to count them under, and lumping them together would let one
    // caller exhaust another's budget.
    if (max === undefined || sessionId === undefined) return undefined;
    const used = callCounts.get(sessionId) ?? 0;
    if (used >= max) {
      return {
        reason: 'BUDGET_EXCEEDED',
        message: `Session call budget of ${max} exhausted before ${name}`,
      };
    }
    callCounts.set(sessionId, used + 1);
    return undefined;
  };

  // One implementation for both gated surfaces: a tool call and a prompt
  // fetch differ only in the request type, and duplicating the body would
  // duplicate every rule above with it.
  const gate = async <Req extends NamedRequest, Res>(
    req: Req,
    next: (req: Req) => Promise<Res>,
    ctx: ProxyContext,
  ): Promise<Res> => {
    const name = req.params.name;
    const outcome = evaluate(name, ctx.identity);
    if ('reason' in outcome) reject(ctx, outcome);

    // Budget last: a call the rules already rejected must not spend it.
    const overBudget = spendBudget(ctx.sessionId, name);
    if (overBudget) reject(ctx, overBudget);

    ctx.policy = Object.freeze<PolicyDecision>({
      decision: 'allow',
      ruleId: outcome.ruleId,
    });
    return next(req);
  };

  return {
    middleware: (req, next, ctx) => gate(req, next, ctx),
    promptMiddleware: (req, next, ctx) => gate(req, next, ctx),
  };
}
