# @mcpose/consent

[![npm](https://img.shields.io/npm/v/@mcpose/consent)](https://www.npmjs.com/package/@mcpose/consent)
[![license](https://img.shields.io/npm/l/@mcpose/consent)](https://github.com/amir-gorji/mcpose/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@mcpose/consent)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml/badge.svg)](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml)

**Fail-closed consent gate middleware for [`mcpose`](https://www.npmjs.com/package/mcpose).**

One question, asked before every gated call: has this caller consented to this tool?
The answer comes from your `resolveConsent` function, and the gate lets the call through only on an unambiguous `true`.
Every refusal is a `CONSENT_MISSING` rejection thrown inside the pipeline, so audit middleware composed outside it records the refusal.

This package is the **enforcement point**, not the definition of consent.
What counts as consent, how granular it is, when it expires, and how a withdrawal is recorded are all yours.

The gate implements the consent half of [ADR-0018](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0018-cryptographic-erasure-and-the-chain.md), whose other half is cryptographic erasure in `@mcpose/audit`.

## Table of Contents

- [When to reach for it](#when-to-reach-for-it)
- [Install](#install)
- [Quick start](#quick-start)
- [Composition order: consent inside, audit outside](#composition-order-consent-inside-audit-outside)
- [Fail closed, in every direction](#fail-closed-in-every-direction)
- [The GDPR/CCPA picture](#the-gdprccpa-picture)
- [API surface](#api-surface)
- [What it does not do](#what-it-does-not-do)
- [Documentation](#documentation)
- [License](#license)

## When to reach for it

Reach for it when some calls your proxy forwards need a lawful basis that a role cannot express.
A treasury analyst may be fully authorized to run `export_customer_records` and still have no right to run it against a customer who never consented, or who has withdrawn.
Authorization answers "may this caller do this"; consent answers "may this be done at all, for this subject, right now".

`@mcpose/policy` is the wrong home for the second question, and deliberately so.
Policy evaluation is pure and synchronous ([ADR-0017](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0017-policy-engine-contract.md)): a rule set is compiled ahead of time and consulted with no I/O.
Consent is external state that has to be looked up, and it changes without anyone redeploying a rule set.
Putting it behind its own middleware keeps the policy engine's no-I/O guarantee intact.

Skip it if nothing you forward is done on behalf of a data subject who could refuse.

## Install

**Prerequisites**

- Node.js 20 or newer.
- `mcpose` 3.x, a peer dependency you install yourself.

```bash
npm install @mcpose/consent
```

This package has no runtime dependencies and no peer beyond `mcpose`.

## Quick start

```ts
import { createBackendClient, startHttpProxy } from 'mcpose';
import { createConsentMiddleware } from '@mcpose/consent';

const consent = createConsentMiddleware({
  // Your consent source. Async is expected: this is a lookup, not a rule.
  resolveConsent: async (identity, toolName) =>
    consentDb.hasActiveGrant(identity.sub, toolName),
  // A broken consent source refuses calls; this is how you find out.
  onResolverError: (err, { subject, name }) =>
    logger.error({ err, subject, name }, 'consent lookup failed'),
});

await startHttpProxy(
  await createBackendClient({ command: 'node', args: ['./crm-server.js'] }),
  {
    name: 'crm-proxy',
    toolMiddleware: [audit.middleware, consent.middleware],
    promptMiddleware: [audit.promptMiddleware, consent.promptMiddleware],
  },
  { resolveIdentity: async (req) => verifyJwt(req.headers.authorization) },
);
```

A refused call throws an MCP error carrying `error.data.rejectionReason`, exactly like every other mcpose rejection:

```ts
try {
  await client.callTool({ name: 'export_customer_records', arguments: {} });
} catch (err) {
  err.data.rejectionReason; // 'CONSENT_MISSING'
}
```

## Composition order: consent inside, audit outside

Put the consent middleware **inside** `@mcpose/audit`, the same way `@mcpose/policy` goes:

```ts
toolMiddleware: [audit.middleware, consent.middleware],
```

`ProxyOptions` arrays run outermost-first, so `audit.middleware` wraps `consent.middleware`.

The refusal happens before the backend call whichever way round you compose them, so this is not about safety.
It is about evidence.
A refusal thrown by the consent gate propagates out through the audit middleware, which records it as a rejected call carrying `CONSENT_MISSING`, so every call blocked for want of consent lands in the tamper-evident trail by construction.
Compose consent outside audit and the audit layer never sees the refusal: the call is blocked, and there is no record that anyone tried.

For a regulated deployment, that record is the point.
"We refused because there was no consent" is a claim you want a signed trail to back.

Where you put it relative to `@mcpose/policy` is your call, and it changes only which reason a caller sees first.
`[audit, policy, consent]` tells an unauthorized caller they are unauthorized without consulting the consent source at all, which also keeps the lookup off the path of calls that were going to be denied anyway.

## Fail closed, in every direction

There is exactly one way through this gate, and it is `resolveConsent` returning `true`.

| Situation | Outcome |
|---|---|
| Resolver returns `true` | The call proceeds. |
| Resolver returns `false` | `CONSENT_MISSING`. |
| Resolver returns anything else (a truthy non-boolean from an untyped host) | `CONSENT_MISSING`. The check is `!== true`, not falsiness. |
| Resolver throws or rejects | `CONSENT_MISSING`, and `onResolverError` is called. |
| No `ctx.identity` | `CONSENT_MISSING`, without calling the resolver at all. |

Two of those deserve their reasoning spelled out.

**A resolver that throws is not a grant.**
A consent database that is down, a timeout, a bug in the lookup: none of them are evidence that anyone consented.
Failing open on a broken consent source is the one failure mode a consent gate must not have, because it produces exactly the outcome the regulation exists to prevent, and it produces it silently and at scale.
The thrown value goes to `onResolverError` and never to the client, since the health of your consent source is not something a caller asked about.

**No identity means no consent.**
Consent belongs to a data subject.
With no resolved `ctx.identity` there is no subject whose consent could be checked, so there is nothing to check and the call is refused.
Note that this differs from `@mcpose/audit`, which degrades a missing identity to an anonymous one rather than failing: recording an anonymous call is honest, but treating an anonymous caller as consenting would not be.

## The GDPR/CCPA picture

This package is one of two halves, and it is worth seeing them together.

**Consent is the gate at the front.**
Before a call touches a data subject's data, `resolveConsent` decides whether there is a lawful basis for it, and a refusal is recorded in the audit trail rather than vanishing.

**Cryptographic erasure is the exit at the back.**
An erasure request has to make a subject's recorded data unrecoverable, while a tamper-evident audit trail exists to make history immutable.
`@mcpose/audit`'s [erasable mode](https://github.com/amir-gorji/mcpose/blob/main/packages/audit/README.md#erasable-mode-cryptographic-erasure) reconciles them: pass a `SubjectKeyStore` and every payload is sealed, and every payload hash keyed, under a destroyable per-subject key.

```ts
// The whole erasure operation, once the audit middleware runs with a keyStore.
const tombstone = await keyStore.destroy(subjectId);
// → { destroyedAt: '2026-08-29T09:12:04.118Z' }
```

Destroying that key makes the subject's payloads permanently undecryptable **and** unconfirmable, so nobody can even check a guessed payload against a recorded hash.
The chain and the `ReplayManifest` keep verifying, because payloads are bound to them only by hash.
The tombstone is the evidence that the erasure happened; it lives outside the chain on purpose, because the trail cannot verify facts about key custody.

**Where this stops.**
Consent semantics are yours: this gate does not model purposes, scopes, expiry, versioned consent texts, or withdrawal flows, and it stores nothing.
It calls your function and enforces the answer.
Likewise, erasure reaches the audit trail's payloads and nothing else; whatever your backends stored is your erasure problem, not the proxy's.

## API surface

### `createConsentMiddleware(options)`

Returns `{ middleware, promptMiddleware }`.
Both surfaces share one implementation and one resolver, so a prompt fetch is gated exactly as a tool call is, with the prompt name passed as the name.

```ts
interface ConsentOptions {
  resolveConsent: (
    identity: Identity,
    toolName: string,
  ) => boolean | Promise<boolean>;
  onResolverError?: (
    err: unknown,
    info: { subject: string; name: string },
  ) => void;
}
```

| Option | Required | Behaviour when omitted |
|---|---|---|
| `resolveConsent` | yes | n/a. Called with the resolved `Identity` and the tool or prompt name. |
| `onResolverError` | no | Defaults to `console.error`. The refusal happens either way. |

`middleware` is a `ToolMiddleware` and `promptMiddleware` is a `PromptMiddleware`, both from `mcpose`.
The resolver type is exported as `ResolveConsentFn`.

Names are matched by your resolver, not by this package, so there is no matching semantics to learn.
In a mesh the name it receives is the namespaced one the client sees, `<backendKey>__<tool>`, because that is the name every `ProxyOptions` predicate and middleware sees.

## What it does not do

- **No consent storage.** Nothing is persisted, cached, or memoized here. Your resolver is called on every gated call, so a withdrawal takes effect immediately and caching, if you want it, is yours to control.
- **No consent model.** No purposes, scopes, expiry, or consent-text versions. The gate asks one boolean question.
- **No `ProxyContext` field.** Consent state does not land on the context, by decision (ADR-0018).
- **It does not stamp a decision.** Unlike `@mcpose/policy`, which writes `ctx.policy`, an allowed call leaves no trace here beyond having proceeded. A refusal is visible as an audited `CONSENT_MISSING` rejection.
- **It is not the audit trail.** Compose `@mcpose/audit` outside this middleware to get a record of what was refused, and turn on erasable mode there to get erasure.
- **It is not authorization.** Use `@mcpose/policy` for "may this caller do this".

## Documentation

- [Repository README](https://github.com/amir-gorji/mcpose#readme) for the product overview.
- [ADR-0018](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0018-cryptographic-erasure-and-the-chain.md) for the consent and erasure design.
- [`@mcpose/audit`](https://github.com/amir-gorji/mcpose/blob/main/packages/audit/README.md) for the audit trail and erasable mode.
- [`CONTEXT.md`](https://github.com/amir-gorji/mcpose/blob/main/CONTEXT.md) for the shared vocabulary.

## License

MIT
