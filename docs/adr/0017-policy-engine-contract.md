# The policy engine is deny-by-default middleware that stamps its decision on the context

Core's type surface spent its compatibility budget on a policy engine before one existed ([#118](https://github.com/amir-gorji/mcpose/issues/118)): `ProxyContext.policy` is published as `policy?: never`, and `POLICY_DENIED`, `SENSITIVITY_BLOCKED`, and `BUDGET_EXCEEDED` sit reserved on the `RejectionReason` union with no owner.
Widening `policy?: never` to a real type is a semver-major change to core, so the shape is decided here, once, rather than discovered during implementation.

## The contract

`ProxyContext.policy` widens to an optional, frozen decision record:

```ts
interface PolicyDecision {
  readonly decision: 'allow' | 'deny';
  readonly ruleId?: string;
  readonly reason?: string;
}
```

It holds a decision already made, not a handle to query.
The engine ships as ordinary middleware in a new `@mcpose/policy` package: it evaluates the call, stamps `ctx.policy`, and either calls `next` or throws `rejectionMcpError('POLICY_DENIED', ...)` (or the more specific reasons below).
A handle-to-query was rejected: it would create a second evaluation path that inner middleware could invoke with different inputs than the gate saw, and the pipeline already is the query mechanism.
Core's only change is the type widening; core never evaluates policy itself.

Evaluation is a pure, synchronous function of the rule set, the resolved `Identity`, and the request.
No I/O and no remote policy-decision point sit in the call path: a network hop inside every tool call is a latency and availability coupling this product should not force, and a host that needs a remote PDP can resolve it into rules ahead of time.

The engine denies by default.
A call matched by no rule is rejected, which follows the sensitivity resolver's fail-closed precedent: an RBAC engine that fails open is a decorative one.
Turning the engine on is itself opt-in (it is middleware), so deny-by-default costs nothing to hosts that have not adopted it.

## Ordering: policy inside, audit outside

The recommended composition places the policy middleware innermost and audit outside it (ADR-0002 array order, first entry innermost): `[...policy, ...audit-wrapped-rest]` in response-processing terms.
A denial thrown by policy then propagates out through the audit middleware, which records it as a rejected call with its `rejectionReason`, so policy denial is auditable by construction, answering the question the reservation left open.
The denial happens before the backend call regardless of position; the ordering constraint exists purely so the trail sees it.

## The reserved reasons get owners

- `POLICY_DENIED`: emitted by `@mcpose/policy` when a rule denies or no rule allows.
- `SENSITIVITY_BLOCKED`: emitted by `@mcpose/policy` when a rule keyed on a sensitivity tier blocks the call. The engine accepts the same name-to-tier map shape the audit package uses, so one classification feeds both encryption and blocking.
- `BUDGET_EXCEEDED`: emitted by `@mcpose/policy` when a per-session call budget is exhausted. Budgets are in-memory call counts scoped to the session, matching the bounded session lifecycle from #107; monetary cost models are explicitly out of scope.
- `IDENTITY_UNRESOLVED`: emitted by `@mcpose/policy` when its rules require an identity and `ctx.identity` is absent. It stays a general-purpose reason; the engine is its first emitter, not its owner.

Nothing comes off the union.

## Considered Options

- **`ctx.policy` as a queryable engine handle.** Rejected: two evaluation paths with potentially different inputs; the pipeline is the query.
- **Policy evaluation in core rather than a package.** Rejected: core's job is transparent proxying and the pipeline; every governance feature so far (audit, testing) ships as a package against public surface, and the no-new-runtime-dependency rule is trivially satisfied either way since the engine needs none.
- **Allow-by-default with explicit deny rules.** Rejected: fails open, contradicting the fail-closed posture of the sensitivity resolver and the product's compliance framing.
- **An async `evaluate` supporting remote PDPs.** Rejected: availability and latency coupling in every call; hosts with external policy sources compile them to rules.
- **Dropping `SENSITIVITY_BLOCKED` and `BUDGET_EXCEEDED` from the union.** Rejected: both map to real rule types the engine can ship (tier rules, session call budgets), and removal would break consumers narrowing the published union for no gain.

## Consequences

- [#127](https://github.com/amir-gorji/mcpose/issues/127) implements `@mcpose/policy` to this contract: deny-by-default RBAC rules over roles and tool names, tier rules emitting `SENSITIVITY_BLOCKED`, per-session call budgets emitting `BUDGET_EXCEEDED`, and the one-line core widening of `policy?: never` to `policy?: PolicyDecision`, which is part of the v3 major.
- Middleware running inside the policy layer can read `ctx.policy` and rely on `decision: 'allow'`; middleware outside it sees the field only after the policy layer has run, which is the same visibility rule every stamped context field already follows.
- The audit event schema is unchanged; a denial is recorded through the existing rejection path. Recording the `ruleId` on audit events is a possible future additive field under the ADR-0012 rule, deliberately not taken now.
- A host composing policy outside audit loses denial records; the READMEs must state the recommended order and why.
