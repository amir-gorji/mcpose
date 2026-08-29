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
- [Erasable mode: cryptographic erasure](#erasable-mode-cryptographic-erasure)
- [API surface](#api-surface)
  - [`createAuditMiddleware(options)`](#createauditmiddlewareoptions)
  - [`createSensitivityResolver(map, override?)`](#createsensitivityresolvermap-override)
  - [`createDefaultSigningKeyProvider(secret)`](#createdefaultsigningkeyprovidersecret)
  - [`SubjectKeyStore`](#subjectkeystore)
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
- **Optional erasable mode.** Supply a `SubjectKeyStore` and a subject's payloads become destroyable: `destroy(sub)` kills both decryptability and hash-confirmability for that subject, and the chain and manifest keep verifying ([ADR-0018](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0018-cryptographic-erasure-and-the-chain.md)). Omit it and nothing changes.
- **Never blocks the call path.** Audit failures (a throwing sink, unserializable payloads) are routed to `onAuditError`; the tool call always completes with its real result or error.
  Three configuration errors are the deliberate exception, and all fail before the upstream is reached rather than after: an unavailable signing provider, a `ProxyContext` with no `proxy` identity, and an unavailable `SubjectKeyStore` in erasable mode.
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

`id`, `startedAt`, `endedAt`, `sessionId?`, `delegatedFrom?`, `proxy`, `kind?`, `erasable?`, `identity`, `tool`, `duration_ms`, `outcome`, `sensitivityTier`, `rejectionReason?`, `error?`, `inputHash`, `outputHash`, `replayManifestPosition`.

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

## Erasable mode: cryptographic erasure

A GDPR or CCPA erasure request and a tamper-evident trail pull in opposite directions: one demands a subject's data become unrecoverable, the other exists to make recorded history immutable.
Erasable mode reconciles them, on the observation that payloads are bound to the chain only through their hashes.
Destroying the ability to *read* a payload touches no preimage, so the trail stays exactly as verifiable as it was.

[ADR-0018](https://github.com/amir-gorji/mcpose/blob/main/docs/adr/0018-cryptographic-erasure-and-the-chain.md) is the binding design.

### Activation

Pass a `SubjectKeyStore` as `keyStore`.
That is the whole switch:

```ts
import { createAuditMiddleware, createInMemorySubjectKeyStore } from '@mcpose/audit';

const keyStore = createInMemorySubjectKeyStore(); // dev only, see the warning below

const audit = createAuditMiddleware({
  signingKey,
  sensitivityResolver,
  keyStore,
  onEvent: (event) => sink.write(event),
});

// An erasure request, in full:
const tombstone = await keyStore.destroy('user-42');
// → { destroyedAt: '2026-08-29T09:12:04.118Z' }
```

**Omit `keyStore` and nothing changes.**
Default mode is byte-identical to what it has always been: the same preimages, the same ciphertexts, the same plain `sha256` payload hashes, and no `erasable` marker on any event.
Erasable mode is opt-in per middleware instance, and the two modes never interfere.

### The unit of erasure is the data subject

One random 256-bit key per subject, created on first use, where the subject is the event's resolved `identity.sub`.
Events with no resolved identity share the `anonymous` bucket, so one `destroy('anonymous')` erases all of them together.
Erasure requests arrive per data subject, so that is the unit; anything finer multiplies stored keys without matching a regulatory unit.

The key is fetched before every audited call, at the same pre-call stage as subkey derivation, and for the same reason: with no key there is no way to record the event, so the call fails fast rather than running unaudited.
A store outage therefore refuses calls and recovers on its own once the store returns; nothing is cached, so `destroy` takes effect on the very next call.

### What erasure destroys, and what survives

`destroy(subjectId)` removes the key. That destroys two things at once:

- **Decryptability.** High-tier `inputEncrypted` / `outputEncrypted` were sealed under a key derived from the subject key, so they become permanently unreadable. Nobody can recover them, the operator included.
- **Hash-confirmability.** This is the part a naive design misses. Default `inputHash` / `outputHash` are deterministic and unkeyed, so an adversary holding a *candidate* payload can confirm after erasure that a subject's event contained it. Salting does not help, because a stored salt reproduces the same confirmation. In erasable mode the hashes are `HMAC-SHA256` under a hash subkey of the subject key, so destroying the key destroys the ability to confirm a guess.

What survives is everything the trail is for:

- The **chain** verifies, at every index, before and after erasure. `verifyAuditChain` is unaffected.
- The **`ReplayManifest`** verifies, and its format is unchanged. Erasure is deliberately not recorded in the chain or the manifest: doing so would make the trail assert facts about key custody it cannot verify.
- Every covered field stays readable. Who called what, when, with what outcome, at which tier, under which proxy, is all still there. Only the payload bodies go dark.

Two consequences to be explicit about:

- **Erasure trades replay completeness for compliance.** An erased event's payload cannot be replayed or re-verified against a copy. That is the point of the feature, not a limitation of it.
- **Low- and medium-tier payloads are stored as plaintext** and are not protected by any key, so erasing a subject key does not remove them. Classify anything an erasure request must reach as `high`.

An erased event is indistinguishable, at the format level, from an event whose key custodian simply lost the key.
Accountability for the erasure itself lives in the tombstone the store returns, outside the chain.

### Custody is yours

> **In erasable mode the `SubjectKeyStore` *is* the confidentiality of every high-tier payload it holds a key for.**
> A store that keeps keys in the clear, or that anyone with read access to the event sink can also read, voids the encryption guarantee for every subject in it.
> A store that silently loses keys performs an erasure nobody asked for, and the loss is invisible until someone tries to read a payload back.

`createInMemorySubjectKeyStore()` is the reference implementation and is **not durable**: keys live in one process's heap, so a restart erases every subject and a second proxy instance cannot read what the first recorded.
Use it in development and tests.
A real deployment implements the two-method interface against a KMS, an HSM, or an encrypted, access-controlled table whose read path is itself audited, with the same handling rules as the signing secret.

### What a decryptor has to know

Erasable mode is visible on the record: an event produced under it carries `erasable: true`.
That marker is covered by the chain as an optional field (ADR-0012), so a stored event cannot be silently reinterpreted under the wrong hash scheme, and adding or stripping it fails verification at that index.

A tool that reads payloads back therefore branches on it:

| | `erasable` absent | `erasable: true` |
|---|---|---|
| Event key root | `encRoot = sign('mcpose/v2/enc')` | the subject's stored key |
| `inputHash` / `outputHash` | `sha256(stableStringify(payload))` | `HMAC(hashSubkey, stableStringify(payload))`, where `hashSubkey = HMAC(subjectKey, 'mcpose/v2/hashkey')` |
| Needs the signing secret | yes | yes, for the chain |
| Needs the subject key | no | yes, for the payloads |

The event-key derivation, the AES-256-GCM layout, and the AAD are identical in both modes.
Only the root the key comes from changes.

## API surface

| Export | Purpose |
|---|---|
| `createAuditMiddleware(options)` | Returns `{ middleware, promptMiddleware, closeSession }`. Add `middleware` to `toolMiddleware` and `promptMiddleware` to `promptMiddleware`; call `closeSession(sessionId)` to emit the manifest. |
| `createSensitivityResolver(map, override?)` | Build a `SensitivityResolverFn`. Unknown or invalid tiers resolve to `high`. |
| `createDefaultSigningKeyProvider(secret)` | In-process HMAC-SHA256 `SigningKeyProvider`. |
| `createInMemorySubjectKeyStore()` | Reference `SubjectKeyStore` for [erasable mode](#erasable-mode-cryptographic-erasure). **Not durable**: development and tests only. |
| `verifyAuditChain(events, signingKey)` | **Keyed** chain verification: recomputes every `chainHash` and reports the first tampered index. An empty event list is invalid. |
| `verifyManifestSignature(manifest, signingKey)` | **Keyed** check of the full-manifest signature, in constant time. |
| `computeMerkleRoot` · `computeMerkleProof` · `verifyMerkleProof` | Low-level Merkle helpers for independent verification. |
| `canonicalJson` · `stableStringify` | The canonical serializations the format is defined over, exported so third parties can write their own verifier. |

**Key types:** `AuditEvent` (`LowAuditEvent` \| `MediumAuditEvent` \| `HighAuditEvent`), `AuditEventBase`, `SensitivityTier`, `SensitivityResolverFn`, `SensitivityOverrideFn`, `SigningKeyProvider`, `SubjectKeyStore`, `SubjectKeyTombstone`, `AuditOptions`, `AuditMiddlewareHandle`, `ReplayManifest`, `MerkleProof`, `ChainVerification`.

### `createAuditMiddleware(options)`

<details>
<summary>Show <code>AuditOptions</code> and <code>AuditMiddlewareHandle</code></summary>

```ts
interface AuditOptions {
  signingKey: SigningKeyProvider;
  sensitivityResolver: SensitivityResolverFn;
  onEvent: (event: AuditEvent) => void | Promise<void>;
  /**
   * Supply a store to run in ERASABLE mode; omit it and behaviour is
   * byte-identical to default mode. See "Erasable mode" above.
   */
  keyStore?: SubjectKeyStore;
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

### `SubjectKeyStore`

Custody of the destroyable per-subject keys that make [erasable mode](#erasable-mode-cryptographic-erasure) erasable.
Two methods, both async so a real store can do I/O:

```ts
interface SubjectKeyStore {
  /** The subject's 256-bit key, created at random on first use. */
  getOrCreate(subjectId: string): Promise<Buffer>;
  /** Permanently removes it, and returns the evidence that it happened. */
  destroy(subjectId: string): Promise<{ destroyedAt: string }>;
}
```

- `getOrCreate` is called before every audited call, so it must not memoize past a `destroy`: a subject that calls again after erasure gets a **fresh** key, and the old events stay dead. A rejection fails the audited call rather than letting it run unaudited.
- `destroy` is **idempotent**. Destroying a subject that holds no key still returns a tombstone, because "this subject holds no key" is the state the caller asked for either way, and a repeated erasure request should produce evidence rather than an error.
- The key must be **random**, never derived from the signing secret or from the subject id. A recomputable key cannot be destroyed, so destroying it would be theatre.

`createInMemorySubjectKeyStore()` implements this over a `Map` for development and tests.
It is not durable, and it is not access-controlled; see [Custody is yours](#custody-is-yours).

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
  erasable?: true;               // present only on events recorded in erasable mode
  tool: string;                  // the tool name, or the prompt name when kind is 'prompt'
  duration_ms: number;
  outcome: 'success' | 'rejected' | 'error';
  /** Present when outcome is 'rejected' (from the MCP error's data field). */
  rejectionReason?: RejectionReason;
  /** Present when outcome is 'error': what the upstream call threw. */
  error?: { name: string; message: string };
  inputHash: string;             // SHA-256 over a stable serialization, or a keyed HMAC when erasable
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
