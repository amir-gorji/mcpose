# @mcpose/audit

[![npm](https://img.shields.io/npm/v/@mcpose/audit)](https://www.npmjs.com/package/@mcpose/audit)
[![license](https://img.shields.io/npm/l/@mcpose/audit)](https://github.com/amir-gorji/mcpose/blob/main/LICENSE)

**Tamper-evident audit middleware for [mcpose](https://www.npmjs.com/package/mcpose).**

`@mcpose/audit` turns every tool call flowing through an mcpose proxy into a tamper-evident **audit event**: HMAC-chained to its predecessor, hashed, and — for high-sensitivity calls — encrypted at rest. When a **session** closes, it emits a signed **replay manifest** with a Merkle root and per-event proofs, so any third party can verify that a single event happened without access to the full log.

## When to reach for it

You operate an MCP server in a regulated environment (e.g. financial services) and need to prove, after the fact, exactly which tool calls happened, by whom, in what order — with cryptographic evidence that the record has not been altered, inserted into, or truncated.

## Install

```bash
npm install @mcpose/audit mcpose
```

`mcpose` is a peer dependency. Requires Node.js 18+ (uses `node:crypto`).

## Quick start

```ts
import {
  createAuditMiddleware,
  createDefaultSigningKeyProvider,
  createSensitivityResolver,
} from '@mcpose/audit';
import { startHttpProxy } from 'mcpose';

// Supplied by your application:
//   backend       — an mcpose BackendClient (see `mcpose` docs)
//   auditLog      — your durable sink for audit events
//   manifestStore — your durable sink for replay manifests
//   piiMW         — an upstream redaction middleware
//   extractJwt    — your resolveIdentity function

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

- **Audit event** — a record of one tool call: `identity`, `tool`, `outcome`, input/output hashes, and a `chainHash` linking it to the previous event. `AuditEvent` is a discriminated union on `sensitivityTier`.
- **Sensitivity tier** (`low` | `medium` | `high`) — decides whether the event stores plaintext (`inputRaw`/`outputRaw`) or AES-256-GCM ciphertext (`inputEncrypted`/`outputEncrypted`). Unknown tools default to `high`.
- **Replay manifest** — produced at session close: a Merkle root over every event's `chainHash`, individual `MerkleProof`s, and a signature over the root. Proves *what happened*; it does not re-execute calls.

## Security model

The append-only HMAC chain makes insertion, deletion, or reordering of events detectable; the signed Merkle root anchors the whole session; high-tier payloads are encrypted at rest.

> **The signing secret is the root of all of it.** The per-entry **chain key** and the per-event AES **encryption root** are derived from the secret *through* the `SigningKeyProvider.sign()` oracle with domain separation — never from the public **key id**. The key id (`ReplayManifest.signedBy`) is a public identifier only; **never use it as key material**, and never hand-roll the chain or encryption keys. See **[ADR-0003](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md)** for the reasoning and the attack it closes.

For production, implement `SigningKeyProvider` against your KMS rather than holding the secret in process. `createDefaultSigningKeyProvider` is HMAC-SHA256 in-process signing, suitable for development and single-trust deployments.

## API surface

| Export | Purpose |
|---|---|
| `createAuditMiddleware(options)` | Returns `{ middleware, closeSession }`. Add `middleware` to the pipeline; call `closeSession(sessionId)` to emit the manifest. |
| `createSensitivityResolver(map, override?)` | Build a `SensitivityResolverFn`; `override` takes precedence over the static map. |
| `createDefaultSigningKeyProvider(secret)` | In-process HMAC-SHA256 `SigningKeyProvider`. |
| `computeMerkleRoot` · `computeMerkleProof` · `verifyMerkleProof` | Low-level Merkle helpers for independent verification. |

**Key types:** `AuditEvent` (`LowAuditEvent` \| `MediumAuditEvent` \| `HighAuditEvent`), `AuditEventBase`, `SensitivityTier`, `SensitivityResolverFn`, `SigningKeyProvider`, `AuditOptions`, `AuditMiddlewareHandle`, `ReplayManifest`, `MerkleProof`, `CostMetadata`.

### `AuditOptions`

```ts
interface AuditOptions {
  signingKey: SigningKeyProvider;
  sensitivityResolver: SensitivityResolverFn;
  onEvent: (event: AuditEvent) => void | Promise<void>;
  onManifest?: (manifest: ReplayManifest) => void | Promise<void>;
  hashAlgorithm?: 'SHA-256';   // default: SHA-256
  includeRejections?: boolean; // default: true
  includeCost?: boolean;       // default: true
}
```

`closeSession(sessionId)` returns `undefined` if the session had no events or is unknown. Wire it to `HttpProxyOptions.onSessionClosed`.

## Testing

Verify chains and manifests in your test suite with [`@mcpose/testing`](https://www.npmjs.com/package/@mcpose/testing) — `assertAuditChainIntegrity`, `assertReplayManifestValid`, `assertPiiRedacted`.

## Documentation

- [Full README & API reference](https://github.com/amir-gorji/mcpose#mcposeaudit)
- [ADR-0003 — audit subkeys derived from the signing oracle](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md)
- [CONTEXT.md](https://github.com/amir-gorji/mcpose/blob/main/CONTEXT.md) — canonical domain glossary

## License

MIT © Amir Gorji
