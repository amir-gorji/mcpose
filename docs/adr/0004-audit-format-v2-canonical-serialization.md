# Audit format v2: canonical serialization, full-manifest signature, hardened derivations

The v1 audit format had five independent weaknesses, each individually format-breaking to fix, so they ship together as one `mcpose/v1/*` to `mcpose/v2/*` scheme rotation in `@mcpose/audit` 3.0.0.

1. **Canonical preimages.**
v1 hashed `JSON.stringify` output, making object-key insertion order load-bearing: the documented field order drifted across `types.ts`, `middleware.ts`, and the skill doc, and no independent verifier could reliably reproduce a `chainHash`.
v2 hashes `canonicalJson` (keys sorted lexicographically at every depth, domain-tagged framing: `canonicalJson({domain: 'mcpose/v2/chain', prevChainHash, event})`).
Only the field SET is load-bearing now.
`inputHash`/`outputHash` use `stableStringify`, a total variant that tolerates circular references and BigInt, so client key order cannot change a payload hash and serialization can never throw into the call path.

2. **The signature covers the whole manifest.**
v1 signed only the Merkle root, leaving `sessionId`, `identity`, `eventCount`, and the proofs swappable around a validly signed root.
v2 signs `canonicalJson({domain: 'mcpose/v2/manifest', manifest})` over every field except the signature itself.
Signing `eventCount` also neutralizes the duplicate-last-leaf padding ambiguity (`root([a,b,c]) == root([a,b,c,c])`).

3. **Merkle domain separation.**
Leaves are `sha256('mcpose/v2/leaf\0' + chainHash)` and internal nodes `sha256('mcpose/v2/node\0' + l + r)`, so an internal node can never be replayed as a leaf.
`verifyMerkleProof` now derives each level's direction from `proof.index` and rejects malformed proofs instead of silently defaulting to the left branch.

4. **keyId is no longer `SHA256(secret)`.**
That construction let anyone holding a published manifest brute-force a low-entropy secret offline from `signedBy`.
v2 uses `HMAC(secret, 'mcpose/v2/keyid')`, which cannot be checked against a candidate secret any faster than attacking the signature itself.
(ADR-0003's rule stands: keyId is public and never key material.)

5. **Ciphertext binding.**
Per-event AES keys are now `HMAC(encRoot, 'mcpose/v2/eventkey\0' + sessionId + '\0' + position + '\0' + eventId)` so key uniqueness holds even when a host reuses a requestId, and AES-GCM gets AAD (`'mcpose/v2/aad\0' + eventId + '\0input'|'\0output'`) so input and output ciphertexts cannot be swapped within an event.

## Considered Options

A dual-format mode (verify v1, write v2) was rejected: v1 chains are forgeable by any manifest-holder with a guessable secret (weakness 4), so continuing to attest them would lend the new verifier's credibility to broken artifacts.
Operators with v1 archives keep verifying them with a pinned `@mcpose/audit` 2.x.

## Consequences

- Chains, manifests, keyIds, and ciphertexts written under v1 do not verify under v2 and vice versa. `@mcpose/audit` gets a major bump (3.0.0).
- The event shape changed with the preimage: `timestamp` became `startedAt`/`endedAt` (end-of-call-only stamping made timestamp order disagree with position order under concurrency), a structured `error` field joined the preimage (v1 hashed every failure to an identical `outputHash`), and the never-implemented `hashAlgorithm`, `includeCost`, `cost`, and `streamedChunkCount` fields were dropped rather than shipped as no-ops.
- The preimage field extractor (`chainPreimageFields`) is shared between the producer and `verifyAuditChain`, so producer/verifier drift is structurally impossible.
- `@mcpose/audit` now exports keyed verifiers (`verifyAuditChain`, `verifyManifestSignature`); the keyless assertions in `@mcpose/testing` remain deliberately weaker and say so.
- The exact label strings are pinned by tests; any future scheme change repeats this ritual as `v3`.
