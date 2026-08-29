# There is no fintech identity package; identity mapping is host resolver code

`@mcpose/fintech-identity` was one roadmap bullet with no ADR, no issue, no code, and no named standard behind it ([#121](https://github.com/amir-gorji/mcpose/issues/121)).
The ticket allowed two outcomes: the bullet earns a specification, or it comes off the roadmap.
This ADR takes it off the roadmap.

## Why no profile is specified

A specification needs a source of truth, and none exists.
No regulation this product cites defines a financial identity profile for tool-call authorization: DORA and SR 11-7 constrain evidence and model governance, not claim schemas, and OIDC deliberately leaves domain claims to deployments.
Any profile written here would be a house shape presented as a standard, and the policy engine (ADR-0017) would then inherit guessed fields as authorization inputs, which is the wrong direction for invented structure to flow.

The core `Identity` type already carries everything a mapping needs: `sub`, `type`, `roles`, and an open `claims` record documented as the landing zone for resolved source claims.
Mapping an institution's OIDC claims into `roles` and `claims` is a few lines of host code inside the `resolveIdentity` hook that already exists for exactly this purpose.
A package wrapping a claims mapping would be a middle man: it could not know any given institution's claim names, so it would either be trivial or configurable to the point of being the host code it replaced.

## What this decides

- The `@mcpose/fintech-identity` bullet comes off the roadmap, and the packages-list sentence naming it is updated.
- The core `Identity` type is unchanged; no new type, field, or package exists for this concern.
- `IDENTITY_UNRESOLVED` stays on the `RejectionReason` union; ADR-0017 already gave it its first emitter, and it is generic rather than fintech-specific.
- A future profile earns its way back only when a concrete regulatory or customer requirement names actual fields, and it arrives as an ADR defining a claims convention, not as a package first.

## Considered Options

- **Define a house financial identity profile now.** Rejected: no standard to anchor it, and guessed fields would propagate into every downstream authorization decision as if they were load-bearing.
- **Ship a thin `@mcpose/fintech-identity` mapping package.** Rejected: a claims mapping is host-specific `resolveIdentity` code; a package version is either trivial or a configuration language for someone else's claim names.
- **Keep the roadmap bullet unspecified.** Rejected: an unspecifiable promise on a compliance product's roadmap is worse than an honest removal.

## Consequences

- The roadmap and the packages list stop promising a package that has no definable content.
- Hosts get their guidance where it belongs: the `resolveIdentity` documentation, which already shows claim mapping.
- If a real profile requirement appears, the ADR defining it supersedes this one explicitly.
