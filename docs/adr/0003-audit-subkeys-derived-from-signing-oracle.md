# Audit subkeys are derived from the signing secret via the oracle, not from keyId

`@mcpose/audit` derives its per-entry HMAC **chain key** and its high-tier AES **encryption root** by calling `SigningKeyProvider.sign()` with domain-separation labels (`mcpose/v1/chain`, `mcpose/v1/enc`); both are functions of the secret and never leave the process. `keyId` is treated strictly as a **public identifier** — it is published in `ReplayManifest.signedBy` — and must never be used as key material.

An earlier implementation keyed both the HMAC chain and the AES encryption off `Buffer.from(keyId, 'hex')`, where `keyId = SHA256(secret)`. Because `keyId` is published in every manifest, a manifest-holder could recompute any `chainHash` (forging the chain) and re-derive any per-event key (decrypting high-tier payloads). That collapsed tamper-evidence to the lone signed Merkle root and voided high-tier confidentiality entirely.

## Considered Options

The provider deliberately exposes only a `sign()` oracle, not raw key bytes. Deriving subkeys *through* the oracle keeps that abstraction intact with no interface change. The alternative — adding `deriveKey()` to `SigningKeyProvider` — was rejected because it breaks every custom provider implementation.

## Consequences

- Derivation relies on `sign()` being a PRF, which the `algorithm: 'HMAC-SHA256'` contract guarantees. A future asymmetric signer would need a different derivation path.
- Subkeys are derived once and cached (a shared promise), since `sign()` is async and the middleware is per-request.
- The `/v1/` segment in the labels versions the derivation scheme, so it can rotate without colliding with chains written under an older scheme.
- This changes the on-disk `chainHash` and ciphertext format versus the earlier implementation; chains written under the old scheme do not verify under the new one.
