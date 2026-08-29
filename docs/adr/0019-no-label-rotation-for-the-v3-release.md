# The v3 release ships audit format v2, amended in place; the label rotation is reserved

[#119](https://github.com/amir-gorji/mcpose/issues/119) asked which queued format breaks ride the `mcpose/v2/*` to `mcpose/v3/*` domain-label rotation, so the bump happens exactly once.
The maintainer's numbering decision changed the premise: the unreleased 3.0.0 tree is the v3 release train, and the last published line is v2, so "the next major" throughout the ADRs and #85 means this unreleased 3.0.0.
That makes the answer to the rotation question: there is no rotation, because there is nothing to rotate away from.

## Why no rotation

A label rotation exists to separate incompatible chain populations that both exist in the wild (ADR-0004 rotated v1 to v2 because published 2.x releases had written v1 archives).
Format v2 has no wild population: the npm registry holds `@mcpose/audit` 2.0.0 through 2.0.3, all of which write format v1, and the v2 writer exists only in this repository's unreleased tree.
ADR-0015 already used this fact to amend v2 in place for `sensitivityTier`, accepting that pre-amendment development chains stop verifying because no published build ever produced one.
The same reasoning covers every remaining pre-release break: rotating to `mcpose/v3/*` now would spend the rotation on a format no release has written, leave the published history claiming a v2 that only ever existed in a branch, and strand nothing because there is nothing to strand.

The 3.0.0 release therefore ships the v2 audit format, as amended before its first publication.
The version number of the packages and the version segment of the domain labels are different namespaces, and `packages/audit/README.md` already states that 3.0.0 writes the v2 format; that stays true.

## What rides the pre-release amendment window

- **The proxy identity becomes a required covered field** ([#123](https://github.com/amir-gorji/mcpose/issues/123)), with mandatory `ProxyOptions.name` ([#122](https://github.com/amir-gorji/mcpose/issues/122)) as its precondition, closing the strip-the-provenance gap ADR-0012 left open for compatibility that no longer needs keeping.
- **The additive `erasable` marker** from ADR-0018, which needed no window at all: it follows the ADR-0012 optional-field rule and would have been legal even post-release.

## What does not ride, and is ruled out for 3.0.0

- **An asymmetric audit signer.** No requirement, no consumer, and no key-distribution substrate names it (ADR-0016 reached the same conclusion for delegation signatures). ADR-0003's note stands: a future asymmetric signer needs a different derivation path, which changes the scheme and is precisely the kind of published-format break that triggers the real rotation.
- **Erasure-related covered fields.** ADR-0018 concluded erasure needs no covered manifest field and no preimage change beyond the additive marker.
- **Everything else.** Any field that can be optional follows the ADR-0012 additive rule at any time and never justifies a rotation.

## The window closes at publication

The moment 3.0.0 publishes, format v2 acquires a wild population and the ADR-0015 exception dies with the reasoning that created it.
From then on: additive optional covered fields remain legal within v2; any required field, any label change, any derivation or serialization or signer change triggers the full ADR-0004 ritual as `mcpose/v3/*`, with a major bump of `@mcpose/audit` and v2 archives verifying only under a pinned 3.x, exactly as v1 archives pin 2.x today.
A dual-format verifier is deferred to that future rotation ADR, to be weighed against the pinned-major answer ADR-0004 chose; committing to one now would be designing for a break whose shape is unknown.

## Considered Options

- **Rotate to `mcpose/v3/*` with the 3.0.0 release anyway.** Rejected: aligning label names with package majors is cosmetic, burns the rotation on an unpublished format, and forces the first real post-release break to be v4 for no gain.
- **Treat #123 as a post-release-style break with a rotation.** Rejected: the field-set change is real but the compatibility cost is zero pre-release, which is ADR-0015's precedent applied unchanged.
- **Land the asymmetric signer now because breaks are free.** Rejected: free compatibility does not make unrequested cryptography free; a signer without a requirement or consumer is speculative surface in the most invariant-sensitive code in the product.

## Consequences

- [#122](https://github.com/amir-gorji/mcpose/issues/122) and [#123](https://github.com/amir-gorji/mcpose/issues/123) are unblocked and land in the unreleased 3.0.0, following the `mcpose-audit-invariants` ritual minus the label bump it reserves for real rotations.
- The domain labels stay `mcpose/v2/*` and their pinning tests are unchanged.
- Development chains written before #123 lands stop verifying once it does, accepted on the ADR-0015 grounds.
- This ADR is the standing answer to "when does the v3 label rotation happen": at the first format break after 3.0.0 publishes, and the rotation ADR written then decides the dual-verifier question.
- Publishing 3.0.0 is the deadline for any remaining required-field ambitions; the release checklist should reference this ADR.
