---
name: mcpose-audit-invariants
description: Use when editing, reviewing, or extending @mcpose/audit (packages/audit) or @mcpose/testing (packages/testing) in the mcpose repo — the HMAC audit chain, Merkle proofs, ReplayManifest, sensitivity tiers, signing-key/subkey derivation, encryption, or the compliance test assertions. Encodes the tamper-evidence invariants that must not silently break.
---

# Editing @mcpose/audit and @mcpose/testing

These two packages produce and verify mcpose's **tamper-evident audit trail**. The failure mode is silent: a change can compile, pass the behavioral tests, and still void the cryptographic guarantee. Read this before touching `packages/audit/src` or `packages/testing/src`.

**Source of truth is the code + `docs/adr/0003` + `docs/adr/0004` + `CONTEXT.md` ("Keys and signing").** Do not trust older plans or PRDs for API shape; verify against the code.

## The trust model — do not break

1. **Tamper-evidence is anchored by the _signed_ ReplayManifest.** `closeSession` signs the canonical serialization of the ENTIRE manifest (`canonicalJson({domain: 'mcpose/v2/manifest', manifest})`) — sessionId, identity, timestamps, eventCount, merkleRoot, proofs, signedBy. Never reduce the signed payload to just the root (that made every other field swappable, and made duplicate-leaf padding ambiguity exploitable). Verify with `verifyManifestSignature`.

2. **`keyId` is PUBLIC — never use it as key material.** It is published in `ReplayManifest.signedBy` and derived as `HMAC(secret, 'mcpose/v2/keyid')` — never bare `SHA256(secret)`, which was offline-brute-forceable for low-entropy secrets. All key material derives from the secret through the `sign()` oracle with domain-separation labels:
   - `chainKey = sign('mcpose/v2/chain')` — keys the per-entry HMAC chain
   - `encRoot  = sign('mcpose/v2/enc')` — root for per-event AES keys; `eventKey = HMAC(encRoot, 'mcpose/v2/eventkey\0' + sessionId + '\0' + position + '\0' + eventId)`

   Both are private functions of the secret and never leave the process. Reintroducing `keyId` (or any published value) as key material re-opens the hole fixed in **ADR-0003**. The `subkey confidentiality (regression)` test in `middleware.test.ts` exists to catch exactly that — keep it passing.

## What the HMAC chain covers — and what it doesn't

`chainHash = HMAC(chainKey, canonicalJson({domain: 'mcpose/v2/chain', prevChainHash, event: preimageFields}))`.

- **Serialization is canonical** (`canonicalJson`: keys sorted at every depth, undefined keys skipped, strict — throws on BigInt/circular). Insertion order is NOT load-bearing anymore; **the field SET is**. The one true field list lives in `chainPreimageFields()` in `chain.ts`, shared by the producer (`middleware.ts`) and the verifier (`verifyAuditChain`) — never fork it.
- **In the preimage**: `id, startedAt, endedAt, sessionId?, delegatedFrom?, identity, tool, duration_ms, outcome, rejectionReason?, error?, inputHash, outputHash, replayManifestPosition`.
- **NOT in the preimage**: `sensitivityTier` and the raw/encrypted payloads. Payloads are bound only via `inputHash`/`outputHash` (computed with `stableStringify` — total, key-order independent, never throws). Post-hoc tampering with `sensitivityTier` is **not** detected by the chain.
- `chainHash` is excluded from its own preimage; the first entry uses `prevChainHash = ''`.

## Lifecycle and robustness invariants

- **Chaining requires `ctx.sessionId`.** Without it (e.g. stdio) there is no session state: every event gets `position 0` and `prevChainHash ''`, and no manifest is produced. Intentional — don't "fix" it into fake chaining.
- **Position allocation is atomic.** The post-call audit section reads `session.events.length`, builds the event (fully synchronous `buildEvent`), and pushes — with NO `await` in between. Adding an `await` there reintroduces duplicate positions under concurrent same-session calls. `middleware.robustness.test.ts` has the concurrency test.
- **The manifest exists only if the host calls `closeSession(sessionId)`.** That is why `createAuditMiddleware` returns `{ middleware, closeSession }` — do not collapse it to a bare middleware.
- **Audit never blocks the call path.** Missing `ctx.identity` degrades to `anonymousIdentity()`; a throwing `onEvent`, a throwing resolver, or unserializable args go to `onAuditError` and must never fail or mask the tool call. The ONLY pre-call failure allowed to fail the call is subkey derivation (no keys ⇒ no audit ⇒ fail fast), and a failed derivation must stay retryable (don't cache the rejected promise).
- **Rejections are audited** (`outcome: 'rejected'` + `rejectionReason`, duck-typed from `err.data.rejectionReason`) unless `includeRejections: false`. The middleware is wrapped in core's `markPassThroughObserver` so `passThroughTools` stay audited — removing that wrapper silently blinds the audit trail.

## Encryption + sensitivity

- High tier: AES-256-GCM, per-event key (formula above), AAD `'mcpose/v2/aad\0' + eventId + '\0input'|'\0output'`, output `= base64(iv[12] ‖ tag[16] ‖ ciphertext)`. A decryptor must split positionally AND supply the right AAD. Dropping the AAD makes input/output ciphertexts swappable within an event.
- **Sensitivity fails CLOSED.** `createSensitivityResolver` uses `Object.hasOwn` (tool names are attacker-controlled — prototype keys like `toString` must not bypass the default), validates tier values, and resolves unknown/garbage to `'high'`. In `buildEvent`, only explicit `'low'`/`'medium'` get plaintext; everything else encrypts. Never invert either check.
- Merkle: leaves are `sha256('mcpose/v2/leaf\0' + chainHash)`, nodes `sha256('mcpose/v2/node\0' + l + r)` — keep the domain separation (an internal node must never verify as a leaf). Odd layers duplicate the last node; a single leaf's root is its tagged leaf hash; empty → `sha256('')` (but `closeSession` never signs an empty manifest, and `verifyAuditChain`/`assertAuditChainIntegrity` reject empty chains). `computeMerkleProof` and `computeMerkleRoot` must use identical padding, and `verifyMerkleProof` derives directions from `proof.index` and rejects malformed proofs.

## Keyed vs keyless verification

`@mcpose/audit` exports the KEYED verifiers: `verifyAuditChain(events, signingKey)` (recomputes every chainHash, reports first bad index) and `verifyManifestSignature(manifest, signingKey)` (constant-time). The `@mcpose/testing` assertions are deliberately **keyless** — state their limits accurately; don't let docs oversell them:

| Assertion | Proves | Does NOT prove |
|---|---|---|
| `assertAuditChainIntegrity` | non-empty; positions sequential; `chainHash`es distinct & non-empty | Authenticity. No HMAC is recomputed, so any self-consistent rewrite passes — and it does not have to be key-consistent, because the forger supplies the hashes. Tail truncation also passes; the manifest's `eventCount` is what catches it |
| `assertReplayManifestValid` | root recomputes from the events; one proof per event; each proof verifies at its index | the manifest **signature** — `verifyManifestSignature` does that |
| `assertPiiRedacted` | low/medium: no pattern matches plaintext; high: no plaintext fields present, encrypted payloads present | anything about the CONTENT of high-tier ciphertext |
| `assertDelegationHonored(event)` | `delegatedFrom` non-empty; each entry has a `sub` | signatures or chain continuity (v3) |

## If you change the chain preimage, key derivation, ciphertext format, or the signed manifest payload

It is a **breaking format change** — old chains won't verify under it. Required ritual:

1. Bump the scheme version in ALL the domain labels (`mcpose/v2/...` → `v3`); don't silently mutate `v2`. The label strings are pinned by tests (`chain.test.ts` "domain label pinning", `signingKey.test.ts`).
2. Update `chainPreimageFields`, the `subkey confidentiality (regression)` test, and any affected behavioral tests.
3. Add an ADR (model on `docs/adr/0004`) and bump `@mcpose/audit` major. CHANGELOG entries come from release tooling — do not hand-edit CHANGELOG.md.
4. Run: `pnpm exec turbo run ts:ci test --filter=@mcpose/audit --filter=@mcpose/testing`
5. `git grep -n 'mcpose/v2/' packages` must return only deliberate remnants (e.g. compat verifiers), never the active write path.
