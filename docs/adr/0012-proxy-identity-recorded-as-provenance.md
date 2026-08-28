# Proxy identity is recorded as provenance, not as a principal

`ProxyOptions.name` had exactly one read site: the SDK `Server` constructor, surfacing in the `initialize` response ([#85](https://github.com/amir-gorji/mcpose/issues/85)).
Nothing downstream could tell which proxy instance handled a request: `ProxyContext` did not carry it, `AuditEvent` had no proxy field, and a `ReplayManifest` identified only the session, the caller, and the signing key id.
For a fleet of proxies, audit trails could not be attributed to an instance.

The decision: `createProxyServer` resolves `{ name, version }` once, defaults included, and stamps it on every `ProxyContext` as `proxy: ProxyIdentity`.
The audit middleware copies it onto each `AuditEvent` and, captured at session start, onto the `ReplayManifest`.

Proxy identity is **provenance, not a principal**.
It is never an entry in `delegatedFrom`, and it takes no part in the caller-attribution model.
ADR-0011 decided that model is caller-identity-only ("the audit side is complete as-is"); that statement was about attributing *outbound calls to callers*, and it stands.
This ADR adds the orthogonal fact ADR-0011 did not address: *which proxy instance wrote the record*.
ADR-0011 also forbids core mutating `ctx.delegatedFrom`, which is why the identity travels as a separate field.

## Adding covered fields to the v2 format

Both new fields are covered without a format-version bump, under a rule the code already embodied but no ADR had stated:

**An optional field added with the undefined-omission pattern is additive within the current format version.**

- `chainPreimageFields()` omits an absent optional field entirely, so every event recorded before the field existed keeps its original preimage and keeps verifying.
- The manifest signature covers the canonical serialization of the entire manifest (ADR-0004), and `canonicalJson` skips absent keys, so old manifests rebuild their original payload; `manifestSigningPayload()` mirrors the omission explicitly.
- A **required** new field would change every preimage and be a v3-class break requiring the full ADR-0004 ritual (new domain labels, major bump).

## Considered Options

- **Stamp the proxy into `delegatedFrom`.** Rejected: misrecords the caller chain and violates the ADR-0011 constraint that core never extends it.
- **Record identity only on the manifest, not per event.** Rejected: events are consumed individually via `onEvent` sinks and Merkle proofs; an event verified in isolation would lose its provenance.
- **Bump the format to v3 for the new fields.** Rejected: the omission pattern makes the change verifiably backward compatible; a version bump would force every verifier to dual-path for no cryptographic gain.
- **Make `name` mandatory now.** Rejected in #85 itself: reconsidered at the next major, only now that the name is recorded somewhere that matters.

## Consequences

- Middleware can read `ctx.proxy`; audit events and manifests from a fleet are attributable to an instance.
- Old v2 chains and manifests verify unchanged; new ones are covered including the proxy identity, so post-hoc tampering with recorded provenance is detectable.
- The additive-optional-field rule is now written down; the next covered field follows it or, if required, triggers the v3 ritual.
- Two proxies deliberately configured with the same `name` remain indistinguishable; disambiguation is the operator's naming policy, not a core control.
