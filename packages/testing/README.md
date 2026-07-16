# @mcpose/testing

[![npm](https://img.shields.io/npm/v/@mcpose/testing)](https://www.npmjs.com/package/@mcpose/testing)
[![license](https://img.shields.io/npm/l/@mcpose/testing)](https://github.com/amir-gorji/mcpose/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/amir-gorji/mcpose/actions/workflows/deploy.yml/badge.svg)](https://github.com/amir-gorji/mcpose/actions/workflows/deploy.yml)

**Compliance assertions for [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit) audit chains.**

A small set of assertion functions that verify the tamper-evidence guarantees of an mcpose audit trail: chain integrity, Merkle-proof validity, PII redaction, and delegation handling. Each throws a descriptive `Error` on failure and returns `void` on success.

**Runner-agnostic.** These are plain functions with no test-framework dependency; use them with Vitest, Jest, `node:test`, or any runner.

> **Not to be confused with** `mcpose/testing`: the subpath export of the **core** `mcpose` package, which provides proxy/middleware mocks (`createMockBackendClient`, `runToolMiddleware`). This package (`@mcpose/testing`) is about asserting the **audit chain**.

## When to reach for it

You have an `@mcpose/audit` audit trail and need to verify in your test suite that the chain is intact, Merkle proofs are valid, PII fields are redacted, and agent delegation chains are honored, without coupling your tests to a specific test framework.

## Features

- **Chain integrity verification**: `assertAuditChainIntegrity` detects insertion, deletion, or reordering in the audit trail by checking sequential positions, non-empty chain hashes, and duplicate events.
- **Merkle-proof validation**: `assertReplayManifestValid` verifies every event's Merkle proof against the signed manifest root, confirming the event count matches.
- **PII redaction checks**: `assertPiiRedacted` confirms no sensitive patterns appear in plaintext audit fields; high-tier (encrypted) events pass automatically.
- **Delegation chain validation**: `assertDelegationHonored` ensures every agent delegation entry has a valid identity with a `sub` claim.
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

  assertAuditChainIntegrity(events);                 // no insert/delete/reorder
  assertReplayManifestValid(events, manifest!);      // every Merkle proof verifies
  assertPiiRedacted(events[0], [/\d{16}/]);          // no card numbers in plaintext
});
```

## API

| Function | What it checks |
|---|---|
| `assertAuditChainIntegrity(events)` | Sequential `replayManifestPosition`s, non-empty `chainHash`es, no duplicates; detects insertion, deletion, or reordering. |
| `assertReplayManifestValid(events, manifest)` | `eventCount` matches, and every event's Merkle proof verifies against `merkleRoot`. |
| `assertPiiRedacted(event, patterns)` | No `RegExp` pattern matches the plaintext input/output fields. High-tier (encrypted) events pass automatically. |
| `assertDelegationHonored(chain)` | The delegation chain is non-empty and every `Identity` has a `sub`. |

Re-exports `AuditEvent` and `ReplayManifest` types from `@mcpose/audit` for convenience.

## Documentation

- [Full README & API reference](https://github.com/amir-gorji/mcpose#mcposetesting)
- [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit): the package these helpers verify
- [CONTEXT.md](https://github.com/amir-gorji/mcpose/blob/main/CONTEXT.md): canonical domain glossary

## License

MIT © Amir Gorji
