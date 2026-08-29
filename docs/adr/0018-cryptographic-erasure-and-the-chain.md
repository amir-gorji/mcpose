# Cryptographic erasure destroys stored subject keys and never touches the chain

Erasure and tamper-evidence pull in opposite directions ([#120](https://github.com/amir-gorji/mcpose/issues/120)): a GDPR or CCPA erasure request demands that a data subject's payloads become unrecoverable, while the chain exists to make recorded history immutable.
The reconciliation is already latent in the format: payloads are bound to the chain only through `inputHash`/`outputHash`, so destroying the ability to read a payload does not touch any preimage, and chain verification is unaffected by erasure.
This ADR makes that load-bearing claim explicit and decides the key structure that makes erasure possible at all.

## Why erasure is impossible today

The per-event key is a pure function of the secret: `eventKey = HMAC(encRoot, label + sessionId + position + eventId)` with `encRoot = sign('mcpose/v2/enc')` (ADR-0003, ADR-0004).
Pure derivation is what makes the default mode operationally simple, and it is also exactly what makes selective erasure impossible: no event key exists independently, so the only destroyable unit is the root secret, which erases every subject at once.
Erasure therefore requires a stored key layer, and storage is the cost of deletability: a key that can be destroyed must exist somewhere rather than be recomputable.

## The design: an optional per-subject key layer

`@mcpose/audit` gains an optional erasable mode, activated by providing a `SubjectKeyStore` in `AuditOptions`.

- The erasure unit is the data subject: the resolved `identity.sub` of the recorded event, with a single designated bucket for events that have no resolved identity.
- The store holds one random 256-bit key per subject, created on first use, retrieved before the call alongside the existing subkey derivation (the one pre-call failure path that is allowed to fail the call, per the existing invariant).
- In erasable mode the per-event key derives from the stored subject key instead of `encRoot`, with the same label, position, and event-id inputs and the same AES-256-GCM format and AAD. Nothing about the ciphertext layout changes.
- Erasure is `destroy(subjectId)`: the key ceases to exist, every past payload of that subject becomes permanently undecryptable, and a subsequent call by the same subject transparently gets a fresh key.

The stored keys are deliberately not derivable from the signing secret.
Recomputability and erasability are mutually exclusive, so the erasable mode trades ADR-0003's pure-derivation elegance for the property the regulation actually demands.
Losing the store loses payload access but never chain integrity, because payloads are outside the preimage.

## Hashes are the residual, and erasable mode closes it

Erasure that leaves `inputHash` in place is weaker than it looks: the default hashes are deterministic and unkeyed (`sha256` over `stableStringify`), so an adversary holding a candidate payload can confirm after erasure that the subject's event contained it.
Salting does not fix this, because a stored salt still lets the same adversary recompute the same confirmation.
Only a keyed hash does: in erasable mode, payload hashes are computed as an HMAC under a hash subkey derived from the subject key, so destroying the subject key destroys confirmability along with decryptability.
For non-erased subjects the binding property is unchanged, since whoever holds the payload and the key can still verify it.
The default mode keeps plain deterministic hashes; hosts that never face erasure requests keep replay verification with no key custody.

An event records which mode produced it in an optional `erasable?: true` field, covered by the chain under the ADR-0012 additive-optional rule, so a recorded event cannot be silently reinterpreted under the wrong hash scheme.

## What a verifier sees, and what the manifest does not record

An erased event is chain-valid and undecryptable, indistinguishable at the format level from an event whose key custodian lost the key.
That is a feature, not a gap: recording erasure inside the chain or the `ReplayManifest` would make the trail itself assert facts about key custody it cannot verify, and would put a covered field on the format for what is an operational event.
The manifest is unchanged.
Erasure accountability lives where the act happens: the `SubjectKeyStore` interface returns tombstones (`destroyedAt`) so operators can evidence the erasure itself, outside the chain.

Consequently, nothing in this design requires a covered manifest field or any preimage change beyond the additive `erasable` marker, which is the answer [#119](https://github.com/amir-gorji/mcpose/issues/119) was waiting on.

## Consent is middleware, not context

Consent state is external data owned by the host, so it arrives through a host-provided resolver on the consent middleware ([#130](https://github.com/amir-gorji/mcpose/issues/130)), which throws `rejectionMcpError('CONSENT_MISSING', ...)` inside the pipeline so refusals are audited.
No consent field lands on `ProxyContext`, and consent does not route through the policy engine: policy evaluation is pure and synchronous (ADR-0017), while consent lookups are host I/O.

## Considered Options

- **Destroy at session or event granularity.** Rejected: erasure requests arrive per data subject; finer units multiply stored keys without matching any regulatory unit.
- **A per-subject key derived from the secret plus subject id.** Rejected: derivable keys are recomputable, so destruction would be theater.
- **Recording erasure in the chain or manifest.** Rejected: the trail would assert unverifiable key-custody facts, and it would force a covered-field format change for an operational event.
- **Salted payload hashes.** Rejected: a stored salt still permits targeted confirmation of guessed payloads; only a keyed hash whose key dies with the subject closes the residual.
- **Consent state on `ProxyContext` or inside `@mcpose/policy`.** Rejected: external I/O-backed state fits neither the context contract nor ADR-0017's pure evaluation rule.

## Consequences

- [#130](https://github.com/amir-gorji/mcpose/issues/130) implements the `SubjectKeyStore`, the erasable mode in `@mcpose/audit`, and the consent middleware to this design. The audit changes follow the `mcpose-audit-invariants` ritual, and the `erasable` marker follows the ADR-0012 additive pattern exactly as `proxy` and `kind` did.
- The `subkey confidentiality` regression posture extends to subject keys: they are private key material and must never appear in events, manifests, or telemetry.
- Replay verification of an erased event's payload is impossible by design; documentation must state that erasure trades replay completeness for compliance, and that the chain and manifest remain fully verifiable.
- Key custody becomes a host responsibility in erasable mode; the README must be honest that an insecure store voids the encryption guarantee for every subject in it.
