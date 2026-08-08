# @mcpose/testing

[![npm](https://img.shields.io/npm/v/@mcpose/testing)](https://www.npmjs.com/package/@mcpose/testing)
[![license](https://img.shields.io/npm/l/@mcpose/testing)](https://github.com/amir-gorji/mcpose/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml/badge.svg)](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml)

**Compliance assertions for [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit) audit chains.**

A small set of assertion functions that verify the tamper-evidence guarantees of an mcpose audit trail: chain integrity, Merkle-proof validity, PII redaction, and delegation handling. Each throws a descriptive `Error` on failure and returns `void` on success.

**These assertions are deliberately keyless** — the signing secret is not available to tests. They prove the artifact is internally consistent: they catch reordering, renumbering, duplication, head or middle deletion, and a swapped Merkle root. They do not prove it is authentic. A forger who rewrites every event and regenerates the root and proofs produces a document these assertions accept, and does not need the signing secret to do it. Deleting from the tail also leaves a valid prefix, so `assertAuditChainIntegrity` alone accepts it; `manifest.eventCount` is what catches that. For keyed verification, use `verifyAuditChain(events, signingKey)` and `verifyManifestSignature(manifest, signingKey)` from `@mcpose/audit`.

**Runner-agnostic.** These are plain functions with no test-framework dependency; use them with Vitest, Jest, `node:test`, or any runner.

> **Not to be confused with** `mcpose/testing`: the subpath export of the **core** `mcpose` package, which provides proxy/middleware mocks (`createMockBackendClient`, `runToolMiddleware`). This package (`@mcpose/testing`) is about asserting the **audit chain**.

## When to reach for it

You have an `@mcpose/audit` audit trail and need to verify in your test suite that the chain is intact, Merkle proofs are valid, PII fields are redacted, and agent delegation chains are honored, without coupling your tests to a specific test framework.

## Features

- **Chain structure verification**: `assertAuditChainIntegrity` checks sequential positions and distinct, non-empty chain hashes (catches reordering, renumbering, duplicates; throws on an empty chain). It does not recompute HMACs — use `verifyAuditChain` for that.
- **Manifest consistency**: `assertReplayManifestValid` recomputes the Merkle root from the events under test, requires one proof per event, and verifies every proof at its index. It does not check the manifest signature — use `verifyManifestSignature`.
- **PII redaction checks**: `assertPiiRedacted` confirms no sensitive patterns appear in plaintext low/medium events; high-tier events are structurally checked (no plaintext fields, encrypted payloads present) — their content is ciphertext and is not pattern-scanned.
- **Delegation chain validation**: `assertDelegationHonored(event)` ensures the event carries a non-empty `delegatedFrom` chain whose entries have a `sub`. Signatures and continuity are v3.
- **Runner-agnostic**: plain functions with no test-framework dependency; use with Vitest, Jest, `node:test`, or any runner.

## Table of Contents

- [When to reach for it](#when-to-reach-for-it)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [API](#api)
- [Documentation](#documentation)
- [License](#license)

## Install

```bash
npm install --save-dev @mcpose/testing
```

`mcpose` and `@mcpose/audit` are peer dependencies.

## Quick start

```ts
import { expect, test } from 'vitest'; // or jest, node:test, your choice
import {
  assertAuditChainIntegrity,
  assertReplayManifestValid,
  assertPiiRedacted,
  assertDelegationHonored,
} from '@mcpose/testing';

// Supplied by your test setup:
//   captureAuditEvents: collects the AuditEvents emitted via AuditOptions.onEvent
//   auditHandle: the handle returned by createAuditMiddleware()

test('transfer flow produces a verifiable audit trail', async () => {
  const events = await captureAuditEvents(/* run your scenario */);
  const manifest = await auditHandle.closeSession('session-123');

  assertAuditChainIntegrity(events);                 // positions sequential, hashes distinct, non-empty
  assertReplayManifestValid(events, manifest!);      // every Merkle proof verifies
  assertPiiRedacted(events[0], [/\d{16}/]);          // no card numbers in plaintext
});
```

## API

| Function | Proves | Does NOT prove |
|---|---|---|
| `assertAuditChainIntegrity(events)` | Positions sequential; `chainHash`es distinct and non-empty; non-empty log | Authenticity. No HMAC is recomputed, so any self-consistent rewrite passes — and it does not have to be key-consistent, because the forger supplies the hashes. Tail truncation also passes; the manifest's `eventCount` is what catches it |
| `assertReplayManifestValid(events, manifest)` | Root recomputes from the events; one proof per event; every proof verifies at its index | The manifest **signature** — use `verifyManifestSignature` |
| `assertPiiRedacted(event, patterns)` | low/medium: no pattern matches plaintext; high: no plaintext fields, encrypted payloads present | Anything about what is inside high-tier ciphertext |
| `assertDelegationHonored(event)` | `delegatedFrom` present, non-empty, entries have a `sub` | Delegation signatures or chain continuity (v3) |

Re-exports `AuditEvent` and `ReplayManifest` types from `@mcpose/audit` for convenience.

## Documentation

- [Full README & API reference](https://github.com/amir-gorji/mcpose#mcposetesting)
- [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit): the package these helpers verify
- [CONTEXT.md](https://github.com/amir-gorji/mcpose/blob/main/CONTEXT.md): canonical domain glossary

## License

MIT © Amir Gorji
