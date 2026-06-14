---
name: mcpose-audit-invariants
description: Use when editing, reviewing, or extending @mcpose/audit (packages/audit) or @mcpose/testing (packages/testing) in the mcpose repo — the HMAC audit chain, Merkle proofs, ReplayManifest, sensitivity tiers, signing-key/subkey derivation, encryption, or the compliance test assertions. Encodes the tamper-evidence invariants that must not silently break.
---

# Editing @mcpose/audit and @mcpose/testing

These two packages produce and verify mcpose's **tamper-evident audit trail**. The failure mode is silent: a change can compile, pass the behavioral tests, and still void the cryptographic guarantee. Read this before touching `packages/audit/src` or `packages/testing/src`.

**Source of truth is the code + `docs/adr/0003` + `CONTEXT.md` ("Keys and signing").** The PRD at `~/.claude/plans/grill-me-extremely-to-validated-salamander.md` has **drifted** — it lists `createAuditMiddleware(): ToolMiddleware` and `assertToolBlocked(...)`, neither of which is real. Do not trust it for API shape; verify against the code.

## The trust model — do not break

1. **Tamper-evidence is anchored by the _signed_ Merkle root, not by the per-entry chain.** `closeSession` computes the Merkle root over all `chainHash` values and signs it with the secret via `SigningKeyProvider.sign()`. The chain *links* entries; the signature is the part a third party cannot forge. Never drop or weaken the manifest signature on the theory that "the chain already protects us" — it does not, because of rule 2.

2. **`keyId` is PUBLIC — never use it as key material.** It is published in `ReplayManifest.signedBy`. All key material derives from the secret through the `sign()` oracle with domain-separation labels:
   - `chainKey = sign('mcpose/v1/chain')` — keys the per-entry HMAC chain
   - `encRoot  = sign('mcpose/v1/enc')` — root for per-event AES keys; `eventKey = HMAC(encRoot, eventId)`

   Both are private functions of the secret and never leave the process. Reintroducing `keyId` (or any published value) as the chain/encryption key re-opens the hole fixed in **ADR-0003**. The `subkey confidentiality (regression)` test in `middleware.test.ts` exists to catch exactly that — keep it passing.

## What the HMAC chain covers — and what it doesn't

`chainHash = HMAC(JSON(stableFields) + prevChainHash, chainKey)`.

- **In the preimage** (`stableFields`, in this insertion order): `id, timestamp, sessionId?, delegatedFrom?, identity, tool, duration_ms, outcome, inputHash, outputHash, replayManifestPosition`. `JSON.stringify` preserves insertion order, so **the field set and order are load-bearing** — adding, reordering, or changing the conditional inclusion of any field changes every `chainHash` and breaks verification of already-written chains.
- **NOT in the preimage**: `sensitivityTier`, `cost`, `streamedChunkCount`, and the raw/encrypted payloads. Payloads are bound only via `inputHash`/`outputHash`. Post-hoc tampering with `cost` or `sensitivityTier` is **not** detected by the chain — don't rely on the chain for their integrity.
- `chainHash` is excluded from its own preimage; the first entry uses `prevChainHash = ''`.

## Lifecycle invariants

- **Chaining requires `ctx.sessionId`.** Without it (e.g. stdio) there is no session state: every event gets `position 0` and `prevChainHash ''`, and no manifest is produced. This is intentional — stdio has no session — so don't "fix" it into fake chaining.
- **The manifest exists only if the host calls `closeSession(sessionId)`.** `ToolMiddleware` is per-request with no lifecycle hook, which is *why* `createAuditMiddleware` returns `{ middleware, closeSession }`. Do not collapse it to a bare middleware (the stale PRD says to) — you would lose manifests entirely.
- **Audit never blocks the call path.** Missing `ctx.identity` degrades to `anonymousIdentity()`; it must not throw.

## Encryption + sensitivity

- High tier: AES-256-GCM, `eventKey = HMAC(encRoot, eventId)`, output `= base64(iv[12] ‖ tag[16] ‖ ciphertext)`. Any decryptor must split positionally. Each event has a distinct key.
- `createSensitivityResolver` resolves **unknown tools to `'high'`** (encrypt by default). Never make the unknown-tool default less safe.
- Merkle: odd layers duplicate the last node; a single leaf is its own root; empty → `sha256('')`. `computeMerkleProof` and `computeMerkleRoot` must use identical padding, or proofs won't verify.

## What the @mcpose/testing assertions actually prove

They are deliberately **keyless** (the signing key isn't available to them). State their limits accurately — don't let docs or comments oversell them:

| Assertion | Proves | Does NOT prove |
|---|---|---|
| `assertAuditChainIntegrity` | positions sequential; `chainHash`es distinct & non-empty (catches reorder / insert / delete / dup) | HMAC validity (no key) → not a key-consistent forgery; nothing about non-chained fields |
| `assertReplayManifestValid` | every Merkle proof verifies against the root; `eventCount` matches | the manifest **signature** — the operator verifies that |
| `assertPiiRedacted` | no pattern matches plaintext in **low/medium** events | anything about **high** events — it passes vacuously (they're encrypted) |
| `assertDelegationHonored` | chain non-empty; each entry has a `sub` | signatures or chain continuity (v3) |

## If you change the chain preimage, key derivation, or ciphertext format

It is a **breaking format change** — old chains won't verify under it. Required ritual:

1. Bump the scheme version in the domain labels (`mcpose/v1/...` → `v2`); don't silently mutate `v1`.
2. Update the `subkey confidentiality (regression)` test and any affected behavioral tests.
3. Add/extend an ADR (model on `docs/adr/0003`) and a `### Security` or `### Changed` CHANGELOG entry; bump `@mcpose/audit`.
4. Run: `pnpm exec turbo run ts:ci test --filter=@mcpose/audit --filter=@mcpose/testing`
