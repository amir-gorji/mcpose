# @mcpose/audit

[![npm](https://img.shields.io/npm/v/@mcpose/audit)](https://www.npmjs.com/package/@mcpose/audit)
[![license](https://img.shields.io/npm/l/@mcpose/audit)](https://github.com/amir-gorji/mcpose/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@mcpose/audit)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml/badge.svg)](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml)

**Tamper-evident audit middleware for [mcpose](https://www.npmjs.com/package/mcpose).**

`@mcpose/audit` turns every tool call flowing through an mcpose proxy into a tamper-evident **audit event**: HMAC-chained to its predecessor, hashed, and, for high-sensitivity calls, encrypted at rest.
When a **session** closes it emits a signed **replay manifest** with a Merkle root and per-event proofs, so a third party can verify that a single event happened without access to the full log.

## Table of Contents

- [When to reach for it](#when-to-reach-for-it)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Security model](#security-model)
  - [What the chain covers](#what-the-chain-covers)
  - [What it does not cover](#what-it-does-not-cover)
  - [Key hierarchy](#key-hierarchy)
- [API surface](#api-surface)
  - [`createAuditMiddleware(options)`](#createauditmiddlewareoptions)
  - [`createSensitivityResolver(map, override?)`](#createsensitivityresolvermap-override)
  - [`createDefaultSigningKeyProvider(secret)`](#createdefaultsigningkeyprovidersecret)
  - [`AuditEvent`](#auditevent)
  - [`ReplayManifest`](#replaymanifest)
  - [Verification](#verification)
- [Testing](#testing)
- [Documentation](#documentation)
- [License](#license)

## When to reach for it

You operate an MCP server in a regulated environment and need to prove, after the fact, exactly which tool calls happened, by whom, and in what order, with cryptographic evidence that the record has not been altered, inserted into, or truncated.

If what you actually need is observability (latency, error rates, call volume), reach for mcpose core's `onTelemetry` hook and your existing log pipeline instead.
This package exists for the harder problem: a record that stays credible when someone disputes it.

## Features

- **HMAC-chained audit events.** Every event is cryptographically linked to its predecessor over a canonical serialization, so a secret-holder can detect insertion, deletion, or reordering with `verifyAuditChain`.
- **Signed ReplayManifest.** The signature covers the *entire* manifest (session, identity, timestamps, event count, Merkle root, and every proof), not just the root, so no field is silently swappable.
- **Full coverage.** Rejected calls (hidden tools) and `passThroughTools` are audited too, because the middleware is registered as a pass-through observer.
- **Sensitivity-tiered storage.** Classify tools as low, medium, or high; high-tier payloads are AES-256-GCM encrypted at rest with per-event keys. Unknown or invalid tiers fail closed to `high`.
- **Subkeys derived through the signing oracle.** Chain and encryption keys derive from the signing secret with domain separation, never from the public key id ([ADR-0003](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md)).
- **Never blocks the call path.** Audit failures (a throwing sink, unserializable payloads) are routed to `onAuditError`; the tool call always completes with its real result or error.
  Two configuration errors are the deliberate exception, and both fail before the upstream is reached rather than after: an unavailable signing provider, and a `ProxyContext` with no `proxy` identity.
  Each would otherwise produce a record that cannot be verified or cannot be attributed, so the call fails instead of running unaudited.
  A proxy built by `createProxyServer` always stamps `ctx.proxy`, so only a host that invokes the middleware with its own hand-built context needs to supply it.
- **No storage lock-in.** Events and manifests are pushed to your own sinks through `onEvent` and `onManifest`.

## Install

```bash
npm install @mcpose/audit mcpose
```

Requires Node.js 20+ (uses `node:crypto`).
`mcpose` (`>=3.0.0 <4`) is a peer dependency: the audit event and handle types reference `ProxyIdentity` and `PromptMiddleware`, which core exports from 3.0.0 on.

> **Format note:** version 3.0.0 writes the **v2 audit format** (`mcpose/v2/*` domain labels).
> Chains and manifests written by a 2.x release do not verify under 3.x.
> Keep a pinned 2.x to verify old archives.
> See [ADR-0004](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0004-audit-format-v2-canonical-serialization.md).

## Quick start

```ts
import {
  createAuditMiddleware,
  createDefaultSigningKeyProvider,
  createSensitivityResolver,
} from '@mcpose/audit';
import { startHttpProxy } from 'mcpose';

// Supplied by your application:
//   backend: an mcpose BackendClient (see the `mcpose` docs)
//   auditLog: your durable sink for audit events
//   manifestStore: your durable sink for replay manifests
//   piiMW: an upstream redaction middleware
//   extractJwt: your resolveIdentity function

// The signing secret never leaves the process; every subkey derives from it.
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
  // Redaction first, so audit only ever records clean data.
  { name: 'payments-proxy', toolMiddleware: [piiMW, auditHandle.middleware] },
  {
    resolveIdentity: extractJwt,
    // Flush the replay manifest when the session ends.
    onSessionClosed: (sessionId) => auditHandle.closeSession(sessionId),
  },
);
```

Two wiring details decide whether this actually works:

- **Middleware order.** `ProxyOptions` arrays are in response-processing order, so `[piiMW, auditHandle.middleware]` redacts *before* it audits. Reversing it logs raw PII.
- **`onSessionClosed`.** Without it, no manifest is ever produced, because nothing tells the audit layer a session ended.

**The host owns the close call, and the proxy closes sessions on its own.**
`createAuditMiddleware` holds an in-memory event array per session and releases it only when `closeSession` runs.
`startHttpProxy` fires `onSessionClosed` on every way a session can end: a client DELETE, `sessionTtlMs` expiry, and server shutdown.
Wiring `onSessionClosed` to `closeSession`, as above, is therefore the whole pattern: an abandoned session still expires on the TTL, and its manifest still gets signed and handed to `onManifest`.
Skip the wiring and an abandoned session leaves its events unsigned in memory for the life of the process, which is both a leak and a silent hole in the audit record.

`sessionTtlMs` defaults to 30 minutes and `maxSessions` to 1000, so that expiry happens whether or not a host configures either.
A deployment that opts out with `sessionTtlMs: Infinity` takes back the job of ending abandoned sessions itself.

## How it works

- **Audit event**: the record of one tool call or prompt call: `identity`, `tool`, `outcome`, input and output hashes, and a `chainHash` linking it to its predecessor.
  `AuditEvent` is a discriminated union on `sensitivityTier`; prompt events additionally carry `kind: 'prompt'`.
- **Sensitivity tier** (`low` | `medium` | `high`): decides whether the event stores plaintext (`inputRaw` / `outputRaw`) or AES-256-GCM ciphertext (`inputEncrypted` / `outputEncrypted`).
- **Replay manifest**: produced at session close. A Merkle root over every event's `chainHash`, one proof per event, and a signature over the whole document.
  It proves *what happened*; it does not re-execute anything.

**Sessions are required for chaining.**
Chaining needs `ProxyContext.sessionId`, which only HTTP transport provides.
Over stdio there is no session, so every event carries position 0 with an empty previous hash, and no manifest is produced.
This is intentional, not a gap to work around.

## Security model

The append-only HMAC chain makes insertion, deletion, and reordering detectable **by a holder of the signing secret**.
The signed manifest anchors the whole session, and high-tier payloads are encrypted at rest with AAD binding each ciphertext to its own event and direction.

### What the chain covers

Each link is `HMAC(chainKey, canonicalJson({ domain, prevChainHash, event }))` over this field set:

`id`, `startedAt`, `endedAt`, `sessionId?`, `delegatedFrom?`, `proxy`, `kind?`, `identity`, `tool`, `duration_ms`, `outcome`, `sensitivityTier`, `rejectionReason?`, `error?`, `inputHash`, `outputHash`, `replayManifestPosition`.

Optional fields are omitted from the preimage when absent, so events recorded before an optional field existed keep verifying unchanged (ADR-0012).
`sensitivityTier` and `proxy` are required on every event and are therefore always present, which is why covering each of them amended format v2 in place rather than extending it (ADR-0015 and ADR-0019).
`proxy` was optional at first, and that made removing recorded provenance undetectable: an event that never carried one and an event whose one was stripped produced the same preimage.
Covering it unconditionally closes that gap, at the cost of requiring `ctx.proxy` on every audited request.

Serialization is canonical (keys sorted at every depth), so key insertion order is not load-bearing and an independently written verifier reproduces the same hash.
The **field set** is what matters, and it is defined once in the source and shared by producer and verifier.
An independently written verifier must track the current field set: one pinned to an older set mis-hashes events that carry a newer optional field.

### What it does not cover

Stating the boundaries precisely is the point of an audit trail, so:

- **Payloads are bound only by hash.** `inputHash` / `outputHash` commit to the payload; the raw and encrypted bodies themselves are not in the preimage.
- **The keyless assertions in `@mcpose/testing` do not prove authenticity.** They prove internal consistency, catching reordering, renumbering, duplication, head or middle deletion, and a swapped Merkle root. A forger who rewrites every event and regenerates the root and proofs produces a document they accept, and does not need the signing secret to do it, because the forger supplies the hashes. See [that package's README](https://www.npmjs.com/package/@mcpose/testing) for the per-assertion limits.
- **Tail truncation leaves a valid prefix.** Head and middle deletion renumber everything after them and are caught; truncating the tail is not, so `assertAuditChainIntegrity` accepts it on its own. The manifest's `eventCount` is what catches it.

### Key hierarchy

> **The signing secret is the root of all of it.**
> The per-entry **chain key** and the per-event AES **encryption root** derive from the secret *through* the `SigningKeyProvider.sign()` oracle with domain separation, never from the public **key id**.
> `ReplayManifest.signedBy` is a public identifier only.
> **Never use it as key material**, and never hand-roll the chain or encryption keys.
> See **[ADR-0003](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md)** for the attack this closes.

The secret must be high-entropy (32+ random bytes).
`keyId` is published in every manifest, so a guessable passphrase is offline-attackable.

For production, implement `SigningKeyProvider` against your KMS rather than holding the secret in process.
`createDefaultSigningKeyProvider` is in-process HMAC-SHA256 signing, suitable for development and single-trust deployments.

## API surface

| Export | Purpose |
|---|---|
| `createAuditMiddleware(options)` | Returns `{ middleware, promptMiddleware, closeSession }`. Add `middleware` to `toolMiddleware` and `promptMiddleware` to `promptMiddleware`; call `closeSession(sessionId)` to emit the manifest. |
| `createSensitivityResolver(map, override?)` | Build a `SensitivityResolverFn`. Unknown or invalid tiers resolve to `high`. |
| `createDefaultSigningKeyProvider(secret)` | In-process HMAC-SHA256 `SigningKeyProvider`. |
| `verifyAuditChain(events, signingKey)` | **Keyed** chain verification: recomputes every `chainHash` and reports the first tampered index. An empty event list is invalid. |
| `verifyManifestSignature(manifest, signingKey)` | **Keyed** check of the full-manifest signature, in constant time. |
| `computeMerkleRoot` · `computeMerkleProof` · `verifyMerkleProof` | Low-level Merkle helpers for independent verification. |
| `canonicalJson` · `stableStringify` | The canonical serializations the format is defined over, exported so third parties can write their own verifier. |

**Key types:** `AuditEvent` (`LowAuditEvent` \| `MediumAuditEvent` \| `HighAuditEvent`), `AuditEventBase`, `SensitivityTier`, `SensitivityResolverFn`, `SensitivityOverrideFn`, `SigningKeyProvider`, `AuditOptions`, `AuditMiddlewareHandle`, `ReplayManifest`, `MerkleProof`, `ChainVerification`.

### `createAuditMiddleware(options)`

<details>
<summary>Show <code>AuditOptions</code> and <code>AuditMiddlewareHandle</code></summary>

```ts
interface AuditOptions {
  signingKey: SigningKeyProvider;
  sensitivityResolver: SensitivityResolverFn;
  onEvent: (event: AuditEvent) => void | Promise<void>;
  /**
   * Called with the finished ReplayManifest when closeSession() is invoked.
   *
   * Why this exists: ToolMiddleware is a pure per-request function with no
   * lifecycle hooks, and sessions are owned by the HTTP transport rather
   * than by middleware. The host signals session end via closeSession();
   * onManifest is the push-based delivery mechanism for the result.
   */
  onManifest?: (manifest: ReplayManifest) => void | Promise<void>;
  /** Record events for rejected calls (hidden tools etc.). Default: true. */
  includeRejections?: boolean;
  /**
   * Called when the audit layer itself fails (event serialization, a
   * throwing onEvent sink). The audit layer NEVER throws into the
   * tool-call path. Default: console.error.
   */
  onAuditError?: (
    err: unknown,
    info: { tool: string; requestId: string; sessionId?: string },
  ) => void;
}

interface AuditMiddlewareHandle {
  middleware: ToolMiddleware;
  /** Audits prompts/get. Wire into ProxyOptions.promptMiddleware. */
  promptMiddleware: PromptMiddleware;
  closeSession(sessionId: string): Promise<ReplayManifest | undefined>;
}
```

</details>

`closeSession` returns `undefined` if the session had no events or is unknown; wire it to `HttpProxyOptions.onSessionClosed`.
The returned `middleware` is already marked as a pass-through observer, so tools in `passThroughTools` stay audited with no extra setup.

`promptMiddleware` audits `prompts/get` calls and shares the session chain with `middleware`, so tool and prompt events interleave in one trail and one manifest.
Wire it alongside the tool middleware:

```ts
{
  toolMiddleware: [piiMW, auditHandle.middleware],
  promptMiddleware: [auditHandle.promptMiddleware],
}
```

Prompt events carry `kind: 'prompt'`, with the prompt name in `tool`; an event with no `kind` is a tool call (ADR-0014).
In mesh mode the `BACKEND_UNROUTABLE` rejection for an unroutable prompt name is thrown inside the pipeline, so it is audited like any other rejection.
The sensitivity resolver receives the prompt name as its first argument, so a name-keyed map that does not list a prompt resolves it to `high` and encrypts it.

The handle is a triple rather than a bare middleware for a structural reason: middleware is per-request and has no lifecycle, so session end has to be signalled from outside, and the tool and prompt surfaces are separate pipelines in core.

### `createSensitivityResolver(map, override?)`

```ts
const resolver = createSensitivityResolver(
  { get_balance: 'low', search: 'medium' },
  // Optional override, which takes precedence over the static map.
  // The 4th argument is the map's own resolution (already defaulted to
  // 'high' for unknown tools), so the override can fall back to it.
  (tool, identity, args, mapTier) =>
    identity.roles.includes('admin') ? 'low' : mapTier,
);
```

The override function type is exported as `SensitivityOverrideFn`.

**This resolver fails closed on purpose.**
Tool names are attacker-controlled, so lookup uses `Object.hasOwn` (a tool named `toString` must not inherit a prototype value and bypass the default), tier values are validated, and anything unknown or malformed resolves to `'high'`.
Only an explicit `'low'` or `'medium'` results in plaintext storage.

### `createDefaultSigningKeyProvider(secret)`

```ts
const signingKey = createDefaultSigningKeyProvider(process.env.AUDIT_SECRET!);
// → { algorithm: 'HMAC-SHA256', keyId, sign(data) }
```

`keyId` is derived as a domain-separated HMAC of the secret, not a bare hash of it.
That distinction matters: `keyId` is published in every manifest, and a bare digest would let anyone holding a manifest brute-force a low-entropy secret offline.
It remains **public** either way, so it is never key material.

### `AuditEvent`

A discriminated union on `sensitivityTier`, sharing one base record.

| Tier | Stored fields |
|---|---|
| `'low'` | `inputRaw`, `outputRaw` (plaintext) |
| `'medium'` | `inputRaw`, `outputRaw` (plaintext; PII already redacted upstream) |
| `'high'` | `inputEncrypted`, `outputEncrypted` (AES-256-GCM, per-event key) |

<details>
<summary>Show the <code>AuditEventBase</code> schema</summary>

```ts
type AuditEvent = LowAuditEvent | MediumAuditEvent | HighAuditEvent;

interface AuditEventBase {
  id: string;                    // = ProxyContext.requestId
  startedAt: string;             // ISO timestamp, captured before the upstream call
  endedAt: string;               // ISO timestamp, captured after it settled
  sessionId?: string;
  identity: Identity;
  delegatedFrom?: Identity[];
  proxy: ProxyIdentity;          // { name, version } of the recording proxy instance
  kind?: 'prompt';               // present only on prompt events; absent means a tool call
  tool: string;                  // the tool name, or the prompt name when kind is 'prompt'
  duration_ms: number;
  outcome: 'success' | 'rejected' | 'error';
  /** Present when outcome is 'rejected' (from the MCP error's data field). */
  rejectionReason?: RejectionReason;
  /** Present when outcome is 'error': what the upstream call threw. */
  error?: { name: string; message: string };
  inputHash: string;             // SHA-256 over a stable serialization
  outputHash: string;
  chainHash: string;             // HMAC over the canonical preimage
  replayManifestPosition: number;
}
```

</details>

A missing `ctx.identity` degrades to an anonymous identity rather than failing the call.

### `ReplayManifest`

Produced at session close, covering every audit event with a Merkle root and individual proofs, signed by the `SigningKeyProvider`.
Any third party can verify a single event without access to the full log.

<details>
<summary>Show the <code>ReplayManifest</code> interface</summary>

```ts
interface ReplayManifest {
  sessionId: string;
  identity: Identity;
  proxy: ProxyIdentity;   // { name, version } of the producing proxy instance
  startedAt: string;
  closedAt: string;
  eventCount: number;
  merkleRoot: string;
  merkleProofs: MerkleProof[];
  signedBy: string;   // public keyId
  signature: string;  // HMAC over the canonical serialization of the ENTIRE manifest
}
```

</details>

Merkle leaves and internal nodes are hashed under **different** domain labels, so an internal node can never be presented as a leaf.
Odd layers duplicate the last node, and `closeSession` never signs an empty manifest.

### Verification

```ts
import { verifyAuditChain, verifyManifestSignature } from '@mcpose/audit';

const result = await verifyAuditChain(events, signingKey);
if (!result.valid) throw new Error(`Chain broken at index ${result.firstInvalidIndex}`);

if (!(await verifyManifestSignature(manifest, signingKey))) {
  throw new Error('Manifest signature does not verify');
}
```

These are the **keyed** verifiers and the only ones that prove authenticity.
Use them wherever the signing secret is available: a verification job, a compliance export, an incident investigation.
In test suites, where the secret usually is not available, use [`@mcpose/testing`](#testing) and read its stated limits.

## Testing

Verify chains and manifests in your test suite with [`@mcpose/testing`](https://www.npmjs.com/package/@mcpose/testing): `assertAuditChainIntegrity`, `assertReplayManifestValid`, `assertPiiRedacted`, and `assertDelegationHonored`.

Those assertions are deliberately keyless and prove internal consistency, not authenticity.
Pair them with `verifyAuditChain` and `verifyManifestSignature` anywhere the secret *is* available.

## Documentation

- [Project README](https://github.com/amir-gorji/mcpose#readme): concepts, comparison, and guides
- [ADR-0003: audit subkeys derived from the signing oracle](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md)
- [ADR-0004: audit format v2 and canonical serialization](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0004-audit-format-v2-canonical-serialization.md)
- [`CONTEXT.md`](https://github.com/amir-gorji/mcpose/blob/main/CONTEXT.md): the canonical domain glossary

## License

MIT © Amir Gorji
