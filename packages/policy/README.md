# @mcpose/policy

[![npm](https://img.shields.io/npm/v/@mcpose/policy)](https://www.npmjs.com/package/@mcpose/policy)
[![license](https://img.shields.io/npm/l/@mcpose/policy)](https://github.com/amir-gorji/mcpose/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@mcpose/policy)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml/badge.svg)](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml)

**Deny-by-default authorization middleware for [`mcpose`](https://www.npmjs.com/package/mcpose).**

One middleware that decides whether a caller may make a call, from a rule set over roles and tool names, plus optional sensitivity-tier rules and per-session call budgets.
It stamps its decision on `ctx.policy` and either calls `next` or throws a structured rejection.

Evaluation is a pure, synchronous function of the rules, the resolved identity, and the request name.
There is no I/O and no remote decision point in the call path: a network hop inside every tool call is a latency and availability coupling this product does not force on you.
A host with an external policy source compiles it into `rules` ahead of time.

The engine implements [ADR-0017](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0017-policy-engine-contract.md), which is the binding contract for its shape.

## Table of Contents

- [When to reach for it](#when-to-reach-for-it)
- [Install](#install)
- [Quick start](#quick-start)
- [Composition order: policy inside, audit outside](#composition-order-policy-inside-audit-outside)
- [How a call is decided](#how-a-call-is-decided)
- [Releasing budget counters](#releasing-budget-counters)
- [API surface](#api-surface)
- [What it does not do](#what-it-does-not-do)
- [Documentation](#documentation)
- [License](#license)

## When to reach for it

Reach for it when "which caller may call which tool" is a question your proxy should answer, rather than each backend answering it differently.
`hiddenTools` decides what a caller can *see* and `resolveIdentity` decides *who they are*; this package is the missing third piece, deciding what they may *do*.

Skip it if every caller is equally trusted.
Turning the engine on is opt-in, because it is ordinary middleware, so deny-by-default costs nothing until you wire it in.

## Install

**Prerequisites**

- Node.js 20 or newer.
- `mcpose` 3.x, a peer dependency you install yourself.

```bash
npm install @mcpose/policy
```

This package has no runtime dependencies and no peer beyond `mcpose`.

## Quick start

```ts
import { createBackendClient, startHttpProxy } from 'mcpose';
import { createPolicyMiddleware } from '@mcpose/policy';

const policy = createPolicyMiddleware({
  rules: [
    // Anyone may read.
    { id: 'read', effect: 'allow', roles: '*', tools: ['get_balance'] },
    // Only treasury may move money.
    { id: 'treasury', effect: 'allow', roles: ['treasury'], tools: ['wire_funds'] },
    // Nobody, not even treasury, during the freeze window.
    { id: 'freeze', effect: 'deny', roles: '*', tools: ['wire_funds'] },
  ],
  // Block high-tier data for contractors, reusing one classification map.
  sensitivityRules: [{ roles: ['contractor'], deniedTiers: ['high'] }],
  sensitivity: { get_balance: 'low', ssn_lookup: 'high' },
  budget: { maxCallsPerSession: 500 },
});

await startHttpProxy(
  await createBackendClient({ command: 'node', args: ['./bank-server.js'] }),
  {
    name: 'bank-proxy',
    toolMiddleware: [policy.middleware],
    promptMiddleware: [policy.promptMiddleware],
  },
  {
    resolveIdentity: async (req) => verifyJwt(req.headers.authorization),
    // Release the session's budget counter when the session ends.
    onSessionClosed: (sessionId) => policy.evictSession(sessionId),
  },
);
```

Two wiring details decide whether this behaves:

- **`onSessionClosed`.** Only needed when you configure a `budget`, and required whenever you do. See [Releasing budget counters](#releasing-budget-counters).
- **The wildcard is the string `'*'`, never an element of an array.** `roles: '*'` means every caller; `roles: ['*']` is a literal role name nobody holds. `createPolicyMiddleware` throws on the second form rather than let it match silently.

A denied call throws an MCP error carrying `error.data.rejectionReason`, exactly like every other mcpose rejection:

```ts
try {
  await client.callTool({ name: 'wire_funds', arguments: {} });
} catch (err) {
  err.data.rejectionReason; // 'POLICY_DENIED'
}
```

## Composition order: policy inside, audit outside

Put the policy middleware **innermost** and `@mcpose/audit` outside it:

```ts
toolMiddleware: [audit.middleware, policy.middleware],
```

`ProxyOptions` arrays run outermost-first, so `audit.middleware` wraps `policy.middleware`.

The denial happens before the backend call whichever way round you compose them, so this ordering is not about safety.
It is about evidence.
A denial thrown by the policy layer propagates out through the audit middleware, which records it as a rejected call carrying its `rejectionReason`, so every blocked call lands in the tamper-evident trail by construction.
Compose policy outside audit and the audit layer never sees the denial: the call is blocked, and there is no record that anyone tried.

That is the reasoning in [ADR-0017](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0017-policy-engine-contract.md#ordering-policy-inside-audit-outside).

## How a call is decided

Three gates run in order.
The first one that denies wins, so the reason a caller sees is the most specific one, and a call the rules already rejected never spends budget.

**1. RBAC rules.**
A rule matches when the caller holds at least one of its `roles` (or `roles` is `'*'`) and the tool or prompt name is listed in its `tools` (or `tools` is `'*'`).

- Any matching `deny` rule rejects the call: an explicit deny beats every allow.
- Otherwise at least one matching `allow` rule is required.
- No match at all rejects the call. The engine denies by default, following the fail-closed precedent of the audit sensitivity resolver: an RBAC engine that fails open is a decorative one.

Rejection reason: `POLICY_DENIED`, or `IDENTITY_UNRESOLVED` when there is no `ctx.identity` and every allow rule covering that name requires a role.
An allow rule with `roles: '*'` admits an anonymous caller, so a public tool stays reachable without identity.

**2. Sensitivity tier rules.**
Only consulted when you pass `sensitivityRules`.
The name resolves to a tier through the `sensitivity` map, and a tier rule whose `roles` match the caller and whose `deniedTiers` include that tier rejects the call.
Tier rules can only subtract access: they run after the RBAC rules have already allowed the call.

Unmapped names resolve to `'high'`, fail-closed, the same way `createSensitivityResolver` in `@mcpose/audit` treats them, and the lookup uses `Object.hasOwn` so an attacker-chosen tool name like `toString` cannot inherit a tier off the prototype.
The `sensitivity` map is structurally the map that resolver accepts, so one classification feeds both encryption and blocking.
This package does not import `@mcpose/audit`; the compatibility is structural and there is no dependency in either direction.

Rejection reason: `SENSITIVITY_BLOCKED`.

**3. Per-session call budget.**
Only consulted when you pass `budget`.
Counters are in-memory, keyed by `ctx.sessionId`, and live on the middleware instance: two instances never share a budget, and nothing is persisted across a restart.
The host's bounded session lifecycle is what bounds the map.
A call **without** a session id (stdio without one, for example) is never counted and never blocked, because there is no key to count it under and lumping such calls together would let one caller exhaust another's budget.
Only calls that reach the policy layer are counted, so a tool listed in `passThroughTools` is invisible to the budget.

Rejection reason: `BUDGET_EXCEEDED`.

### Releasing budget counters

**The host owns the eviction call, and the proxy closes sessions on its own.**
Nothing removes a counter but `evictSession`, so wire it to `onSessionClosed`:

```ts
onSessionClosed: (sessionId) => policy.evictSession(sessionId),
```

`startHttpProxy` fires `onSessionClosed` on every way a session can end: a client DELETE, `sessionTtlMs` expiry, and server shutdown.
Wiring it as above is therefore the whole pattern, and an abandoned session still expires on the TTL and still releases its counter.

Skip the wiring and the counter map grows for the life of the process.
`maxSessions` bounds the sessions that are *live*; it does not bound the ids this middleware has already seen, so a long-running proxy accumulates one entry per session forever.

Evicting an unknown session is a no-op, and a session that starts again under the same id gets a fresh budget.
This matters only when you configure a `budget`: with no budget there is nothing to count and nothing to release.

**Stamping.**
Either way, `ctx.policy` is set to a frozen `PolicyDecision` before the middleware calls `next` or throws.
On an allow it is `{ decision: 'allow', ruleId }`; on a denial it is `{ decision: 'deny', reason, ruleId? }`, where `reason` is the rejection reason.
`ruleId` appears only when an identifiable rule produced that outcome: on a `POLICY_DENIED` from an explicit deny rule, and on an allow.
A `SENSITIVITY_BLOCKED` denial carries no `ruleId`, because the rule that matched *allowed* the call and the tier rule that vetoed it has no id.
Naming the allow rule there would tell an auditor that rule X denied a call it in fact permitted.
Denials with no rule behind them at all (`IDENTITY_UNRESOLVED`, `BUDGET_EXCEEDED`, and a deny-by-default `POLICY_DENIED`) likewise carry none.
Middleware running inside the policy layer can therefore read `ctx.policy` and rely on `decision: 'allow'`.

## API surface

### `createPolicyMiddleware(options)`

Returns `{ middleware, promptMiddleware, evictSession }`.
The two middleware surfaces share one implementation, one rule set, and one budget counter, so a prompt fetch is gated exactly as a tool call is and both spend the same session budget.

It **throws at construction** on a rule set that would silently match less than its author meant, rather than failing open on the first call:

- `'*'` appearing as an *element* of a `roles` or `tools` array, in a policy rule or a sensitivity rule. Written that way it is a literal name that matches nothing. The wildcard is the bare string `roles: '*'`.
- An empty or whitespace-only rule `id`, which is what a stamped decision and an audit record name.

The first is the one place deny-by-default does not save you: `{ effect: 'deny', roles: ['*'], tools: ['wire_funds'] }` reads as "deny everyone", matches nobody, and lets the call through on an allow rule its author believed overridden.

```ts
interface PolicyOptions {
  rules: ReadonlyArray<PolicyRule>;
  sensitivityRules?: ReadonlyArray<SensitivityRule>;
  sensitivity?: Record<string, 'low' | 'medium' | 'high'>;
  budget?: { maxCallsPerSession: number };
}

interface PolicyRule {
  id: string;
  effect: 'allow' | 'deny';
  roles: ReadonlyArray<string> | '*';
  tools: ReadonlyArray<string> | '*';
}

interface SensitivityRule {
  roles: ReadonlyArray<string> | '*';
  deniedTiers: ReadonlyArray<'low' | 'medium' | 'high'>;
}
```

| Option | Required | Behaviour when omitted |
|---|---|---|
| `rules` | yes | n/a. An empty array denies every call. |
| `sensitivityRules` | no | Tiers are not consulted; the `sensitivity` map is unused. |
| `sensitivity` | no | Every name resolves to `'high'`, which matters only if you passed tier rules. |
| `budget` | no | Calls are uncounted and unlimited. |

`middleware` is a `ToolMiddleware` and `promptMiddleware` is a `PromptMiddleware`, both from `mcpose`.
`evictSession(sessionId)` drops that session's budget counter; wire it to `onSessionClosed`, as [above](#releasing-budget-counters).

Names are matched **exactly**, with no glob or pattern engine.
In a mesh the name a rule must list is the namespaced one the client sees, `<backendKey>__<tool>`, because that is the name every `ProxyOptions` predicate and middleware sees.

## What it does not do

- **No pattern matching.** Rules list names literally. A wildcard is `'*'`, meaning "every name", not a glob.
- **No remote policy decision point.** Evaluation is local and synchronous, by design.
- **No monetary cost model.** `budget` counts calls, not dollars or tokens.
- **No persistence.** Budget counters are per-process and per-instance.
- **No consent gating.** `CONSENT_MISSING` stays unowned.
- **It is not the audit trail.** Compose `@mcpose/audit` outside this middleware to get a record of what was denied.

## Documentation

- [Repository README](https://github.com/amir-gorji/mcpose#readme) for the product overview.
- [ADR-0017](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0017-policy-engine-contract.md) for the contract this package implements.
- [`CONTEXT.md`](https://github.com/amir-gorji/mcpose/blob/main/CONTEXT.md) for the shared vocabulary.

## License

MIT
