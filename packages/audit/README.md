# @mcpose/audit

[![npm](https://img.shields.io/npm/v/@mcpose/audit)](https://www.npmjs.com/package/@mcpose/audit)
[![license](https://img.shields.io/npm/l/@mcpose/audit)](https://github.com/amir-gorji/mcpose/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml/badge.svg)](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml)

**Tamper-evident audit middleware for [mcpose](https://www.npmjs.com/package/mcpose).**

`@mcpose/audit` turns every tool call flowing through an mcpose proxy into a tamper-evident **audit event**: HMAC-chained to its predecessor, hashed, and (for high-sensitivity calls) encrypted at rest. When a **session** closes, it emits a signed **replay manifest** with a Merkle root and per-event proofs, so any third party can verify that a single event happened without access to the full log.

## Features

- **HMAC-chained audit events**: every event is cryptographically linked to its predecessor over a canonical serialization; a secret-holder can detect insertion, deletion, or reordering with `verifyAuditChain`.
- **Signed ReplayManifest**: the signature covers the entire manifest (session, identity, event count, Merkle root, and proofs); per-event Merkle proofs let third parties verify a single event without access to the full log.
- **Full coverage**: rejected calls (hidden tools) and `passThroughTools` are audited too — the middleware is a pass-through observer.
- **Sensitivity-tiered storage**: classify tools as low, medium, or high sensitivity; high-tier payloads are AES-256-GCM encrypted at rest with per-event keys; unknown or invalid tiers fail closed to `high`.
- **Subkey derivation through the signing oracle**: chain keys and encryption keys derive from the signing secret through domain-separated derivation, never from the public key id (see [ADR-0003](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md) and [ADR-0004](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0004-audit-format-v2-canonical-serialization.md)).
- **Never blocks the call path**: audit failures (a throwing sink, unserializable payloads) are routed to `onAuditError`; the tool call always completes with its real result or error.
- **Durable-sink integration**: push audit events and replay manifests to your own storage via `onEvent` and `onManifest` callbacks. No lock-in to a specific database or log system.

## When to reach for it

You operate an MCP server in a regulated environment (e.g. financial services) and need to prove, after the fact, exactly which tool calls happened, by whom, in what order, with cryptographic evidence that the record has not been altered, inserted into, or truncated.

## Table of Contents

- [Features](#features)
- [When to reach for it](#when-to-reach-for-it)
- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Security model](#security-model)
- [API surface](#api-surface)
- [Testing](#testing)
- [Documentation](#documentation)
- [License](#license)

## Install

```bash
npm install @mcpose/audit mcpose
```

`mcpose` (>= 2.2.0) is a peer dependency. Requires Node.js 20+ (uses `node:crypto`).

> **Format note:** version 3.0.0 writes the v2 audit format (`mcpose/v2/*` domain labels). Chains and manifests written by 2.x do not verify under 3.x; keep a pinned 2.x for verifying old archives. See [ADR-0004](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0004-audit-format-v2-canonical-serialization.md).

## Quick start

```ts
import {
  createAuditMiddleware,
  createDefaultSigningKeyProvider,
  createSensitivityResolver,
} from '@mcpose/audit';
import { startHttpProxy } from 'mcpose';

// Supplied by your application:
//   backend: an mcpose BackendClient (see `mcpose` docs)
//   auditLog: your durable sink for audit events
//   manifestStore: your durable sink for replay manifests
//   piiMW: an upstream redaction middleware
//   extractJwt: your resolveIdentity function

// The signing secret never leaves the process; all subkeys derive from it.
const signingKey = createDefaultSigningKeyProvider(process.env.AUDIT_SECRET!);

// Map tools to a sensitivity tier. Unknown tools resolve to 'high'.
const sensitivityResolver = createSensitivityResolver({
  get_balance:    'low',
  search_trades:  'medium',
  transfer_funds: 'high',
});

const auditHandle = createAuditMiddleware({
  signingKey,
  sensitivityResolver,
  onEvent: (event) => auditLog.append(event),
  onManifest: (manifest) => manifestStore.save(manifest),
});

await startHttpProxy(
  backend,
  { toolMiddleware: [piiMW, auditHandle.middleware] },
  {
    resolveIdentity: extractJwt,
    // Flush the replay manifest when the session ends.
    onSessionClosed: (sessionId) => auditHandle.closeSession(sessionId),
  },
);
```

## How it works

- **Audit event**: a record of one tool call: `identity`, `tool`, `outcome`, input/output hashes, and a `chainHash` linking it to the previous event. `AuditEvent` is a discriminated union on `sensitivityTier`.
- **Sensitivity tier** (`low` | `medium` | `high`): decides whether the event stores plaintext (`inputRaw`/`outputRaw`) or AES-256-GCM ciphertext (`inputEncrypted`/`outputEncrypted`). Unknown tools default to `high`.
- **Replay manifest**: produced at session close: a Merkle root over every event's `chainHash`, individual `MerkleProof`s, and a signature over the root. Proves *what happened*; it does not re-execute calls.

## Security model

The append-only HMAC chain makes insertion, deletion, or reordering of events detectable **by a holder of the signing secret** (use `verifyAuditChain`); without the secret, the keyless assertions in `@mcpose/testing` prove internal consistency — reordering, renumbering, duplication, head or middle deletion, and a swapped Merkle root — but not authenticity (see the [`@mcpose/testing` README](https://www.npmjs.com/package/@mcpose/testing) for the limits). The signed manifest anchors the whole session; high-tier payloads are encrypted at rest with AAD binding each ciphertext to its event and direction.

> **The signing secret is the root of all of it.** The per-entry **chain key** and the per-event AES **encryption root** are derived from the secret *through* the `SigningKeyProvider.sign()` oracle with domain separation, never from the public **key id**. The key id (`ReplayManifest.signedBy`) is a public identifier only; **never use it as key material**, and never hand-roll the chain or encryption keys. See **[ADR-0003](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md)** for the reasoning and the attack it closes.

For production, implement `SigningKeyProvider` against your KMS rather than holding the secret in process. `createDefaultSigningKeyProvider` is HMAC-SHA256 in-process signing, suitable for development and single-trust deployments. The secret must be high-entropy (32+ random bytes) — `keyId` is published in every manifest, so a guessable passphrase is offline-attackable.

## API surface

| Export | Purpose |
|---|---|
| `createAuditMiddleware(options)` | Returns `{ middleware, closeSession }`. Add `middleware` to the pipeline; call `closeSession(sessionId)` to emit the manifest. |
| `createSensitivityResolver(map, override?)` | Build a `SensitivityResolverFn`; `override` receives the map's resolution as its fourth argument and can fall back to it. Unknown or invalid tiers resolve to `high`. |
| `createDefaultSigningKeyProvider(secret)` | In-process HMAC-SHA256 `SigningKeyProvider`. |
| `verifyAuditChain(events, signingKey)` | KEYED chain verification: recomputes every chainHash; reports the first tampered index. |
| `verifyManifestSignature(manifest, signingKey)` | Recomputes the full-manifest signature; constant-time comparison. |
| `computeMerkleRoot` · `computeMerkleProof` · `verifyMerkleProof` | Low-level Merkle helpers for independent verification. |
| `canonicalJson` · `stableStringify` | The canonical serializations the format is defined over (for independent verifiers). |

**Key types:** `AuditEvent` (`LowAuditEvent` \| `MediumAuditEvent` \| `HighAuditEvent`), `AuditEventBase`, `SensitivityTier`, `SensitivityResolverFn`, `SensitivityOverrideFn`, `SigningKeyProvider`, `AuditOptions`, `AuditMiddlewareHandle`, `ReplayManifest`, `MerkleProof`, `ChainVerification`.

### `AuditOptions`

```ts
interface AuditOptions {
  signingKey: SigningKeyProvider;
  sensitivityResolver: SensitivityResolverFn;
  onEvent: (event: AuditEvent) => void | Promise<void>;
  onManifest?: (manifest: ReplayManifest) => void | Promise<void>;
  includeRejections?: boolean; // default: true — audit rejected calls too
  onAuditError?: (err, info) => void; // default: console.error — audit never throws into the call path
}
```

`closeSession(sessionId)` returns `undefined` if the session had no events or is unknown. Wire it to `HttpProxyOptions.onSessionClosed`.

## Testing

Verify chains and manifests in your test suite with [`@mcpose/testing`](https://www.npmjs.com/package/@mcpose/testing): `assertAuditChainIntegrity`, `assertReplayManifestValid`, `assertPiiRedacted`.

## Documentation

- [Full README & API reference](https://github.com/amir-gorji/mcpose#mcposeaudit)
- [ADR-0003: audit subkeys derived from the signing oracle](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md)
- [CONTEXT.md](https://github.com/amir-gorji/mcpose/blob/main/CONTEXT.md): canonical domain glossary

## License

MIT © Amir Gorji
