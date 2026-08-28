# The sensitivity tier is covered by the chain, amending format v2 in place

The HMAC chain preimage covered every field of an audit event that mattered except the one that says how the payload was handled.
`chainPreimageFields()` omitted `sensitivityTier` ([#106](https://github.com/amir-gorji/mcpose/issues/106)), so an attacker with write access to stored events could relabel a `high` event as `low` and keyed verification would still pass at every index.
The relabelled record then claims a payload was stored in plaintext, or that a plaintext payload was encrypted at rest, and the trail attests to that claim.

For a product sold on a tamper-evident trail, a classification the trail does not protect is worse than no classification: it carries the credibility of the chain without the guarantee.
The gap was documented rather than fixed, which is honest but is not a control.

The decision: `sensitivityTier` joins the preimage as a plain always-present field, and format v2 is amended in place to include it.

## Why the additive-optional pattern does not apply

[#106](https://github.com/amir-gorji/mcpose/issues/106) proposed adding the field with the undefined-omission pattern that ADR-0012 wrote down and ADR-0014 reused, on the argument that it would then be additive within v2.
That argument does not hold here.
`sensitivityTier` is the required discriminant of the `AuditEvent` union: every event ever recorded carries one, and the type system does not permit an event without one.
An omission guard on a field that is never absent is unconditional inclusion wearing a disguise.

The pattern in ADR-0012 works because an absent optional key makes `canonicalJson` reproduce an old event's original preimage byte for byte.
There is no old event here whose preimage is preserved: adding a required field changes the preimage of every event that exists.
ADR-0012 already stated the rule and its consequence, that a required new field is a v3-class break, and ADR-0014 restated it when rejecting a required `kind`.
Writing the omission guard anyway would not have made the change compatible, only misdocumented it.

## Why this amends v2 rather than rotating to v3

The v2 writer has never been released.
The npm registry holds `@mcpose/audit` 2.0.0, 2.0.2, and 2.0.3, all of which write format v1; format v2 arrives with the unreleased 3.0.0 in this tree.
No v2 chain exists outside this repository's own development runs, so there is no archive for a rotation to protect and nothing that a compatibility break can strand.

Rotating the labels to `mcpose/v3/*` now would spend the rotation on an unpublished format.
[#119](https://github.com/amir-gorji/mcpose/issues/119) is gathering the changes that genuinely require a rotation, including making the proxy identity a required covered field and deciding on an asymmetric signer path, so that the format bump happens exactly once after v2 ships.
Amending v2 before its first release keeps that rotation reserved for its purpose, and keeps the released-format history a clean v1 to v2 step.

## Considered Options

- **Add the field with the undefined-omission pattern.** Rejected: the field is a required discriminant, so the guard never fires and the change is not additive. See above.
- **Rotate the labels to `mcpose/v3/*` now.** Rejected: it would burn the one rotation that [#119](https://github.com/amir-gorji/mcpose/issues/119) is planning, on a format no release has ever written, and would leave the published history with a v2 that existed only in a git branch.
- **Make `sensitivityTier` optional so the omission pattern applies.** Rejected: it is the union discriminant, and an event without a tier has no defined storage shape. Weakening the type to make a compatibility argument work is the wrong direction.
- **Leave the gap documented.** Rejected: documenting an attack is not mitigating it, and this one needs only write access to stored events, which is exactly the adversary the chain exists to defeat.
- **Bind the tier through the manifest signature instead.** Rejected: events are consumed individually through `onEvent` sinks and Merkle proofs, so an event verified in isolation would still carry an unprotected tier.

## Consequences

- Relabelling the tier of a stored event, in either direction, or dropping it, now fails keyed verification at exactly that index.
- Chains written by a pre-amendment development build of 3.0.0 no longer verify. This is accepted precisely because no such build was ever published: the affected set is this repository's own test and development output.
- `buildEvent` now resolves the fail-closed tier before it builds the preimage, so the value it hashes is the value the event ships. Deciding the tier after the hash, as the code did when the field was uncovered, would silently omit it from the producer's preimage while the verifier included it.
- The domain labels stay `mcpose/v2/*` and their pinning tests are unchanged, so [#119](https://github.com/amir-gorji/mcpose/issues/119)'s rotation is unaffected and still the only planned one.
- The v2 field set is now closed to further required additions: once 3.0.0 is published, the next required covered field triggers the full ADR-0004 ritual with no exception available.
