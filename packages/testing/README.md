# @mcpose/testing

[![npm](https://img.shields.io/npm/v/@mcpose/testing)](https://www.npmjs.com/package/@mcpose/testing)
[![license](https://img.shields.io/npm/l/@mcpose/testing)](https://github.com/amir-gorji/mcpose/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@mcpose/testing)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml/badge.svg)](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml)

**Compliance assertions for [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit) audit chains.**

Four assertion functions that verify the tamper-evidence properties of an mcpose audit trail: chain integrity, Merkle-proof validity, PII redaction, and delegation handling.
Each throws a descriptive `Error` on failure and returns `void` on success.

They are plain functions with no test-framework dependency, so they work with Vitest, Jest, `node:test`, or any runner.

> **Not to be confused with** `mcpose/testing`, the subpath export of the **core** `mcpose` package, which provides proxy and middleware mocks (`createMockBackendClient`, `runToolMiddleware`).
> That subpath mocks the proxy; this package asserts the **audit chain**.

## Table of Contents

- [What these assertions prove](#what-these-assertions-prove)
- [When to reach for it](#when-to-reach-for-it)
- [Install](#install)
- [Quick start](#quick-start)
- [API](#api)
- [Documentation](#documentation)
- [License](#license)

## What these assertions prove

Read this before relying on them in a compliance suite.

**These assertions are deliberately keyless**, because the signing secret is not available to tests.
They prove an audit artifact is **internally consistent**: they catch reordering, renumbering, duplication, head or middle deletion, and a swapped Merkle root.

**They do not prove it is authentic.**
A forger who rewrites every event and regenerates the root and proofs produces a document these assertions accept, and does not need the signing secret to do it, because the forger supplies the hashes.
Deleting from the tail also leaves a valid prefix, so `assertAuditChainIntegrity` alone accepts it; `manifest.eventCount` is what catches that.

For authenticity, use the **keyed** verifiers from `@mcpose/audit` wherever the secret is available:

```ts
import { verifyAuditChain, verifyManifestSignature } from '@mcpose/audit';
```

The right mental model: these assertions are a *structural regression guard* for your pipeline, catching the day someone reorders middleware or drops events on the floor.
They are not the thing you hand a regulator.

## When to reach for it

You have an `@mcpose/audit` trail and need your test suite to fail when the chain stops being intact, Merkle proofs stop verifying, PII leaks into a plaintext tier, or a delegation chain goes missing, without coupling the tests to a specific test framework.

## Install

```bash
npm install --save-dev @mcpose/testing
```

Requires Node.js 20+.
`mcpose` and `@mcpose/audit` are peer dependencies.

## Quick start

```ts
import { test } from 'vitest'; // or jest, node:test, your choice
import {
  assertAuditChainIntegrity,
  assertReplayManifestValid,
  assertPiiRedacted,
} from '@mcpose/testing';

// Supplied by your test setup:
//   captureAuditEvents: collects the AuditEvents emitted via AuditOptions.onEvent
//   auditHandle: the handle returned by createAuditMiddleware()

test('transfer flow produces a verifiable audit trail', async () => {
  const events = await captureAuditEvents(/* run your scenario */);
  const manifest = await auditHandle.closeSession('session-123');

  assertAuditChainIntegrity(events);            // positions sequential, hashes distinct and non-empty
  assertReplayManifestValid(events, manifest!); // every Merkle proof verifies against the root
  assertPiiRedacted(events[0], [/\d{16}/]);     // no card numbers in plaintext
});
```

`closeSession` returns `undefined` for an unknown session or one with no events, which is why the example asserts on `manifest!`.
If a manifest is expected, assert that it exists rather than asserting through it.

## API

| Function | Proves | Does NOT prove |
|---|---|---|
| `assertAuditChainIntegrity(events)` | The log is non-empty; positions are sequential; `chainHash`es are distinct and non-empty. | Authenticity. No HMAC is recomputed, so any self-consistent rewrite passes, and it need not be key-consistent because the forger supplies the hashes. Tail truncation also passes; the manifest's `eventCount` is what catches it. |
| `assertReplayManifestValid(events, manifest)` | `eventCount` matches; the root recomputes from the events under test; one proof per event; every proof verifies at its own index. | The manifest **signature**. Use `verifyManifestSignature`. |
| `assertPiiRedacted(event, patterns)` | low/medium: no pattern matches the plaintext fields. high: no plaintext fields present, and encrypted payloads are. | Anything about the content of high-tier ciphertext, which is never pattern-scanned. |
| `assertDelegationHonored(event)` | `delegatedFrom` is present and non-empty, and every entry has a `sub`. | Delegation signatures or chain continuity, which are v3. |

Two notes that trip people up:

- `assertAuditChainIntegrity` **throws on an empty chain**, deliberately: a log truncated to zero events must not pass a compliance assertion. If an empty session is the expected outcome, assert that explicitly instead.
- `assertDelegationHonored` only passes when your host application stamps `delegatedFrom` onto the `ProxyContext`. mcpose core does not populate it yet; a delegation header spec is v3 work.

The package also re-exports the `AuditEvent` and `ReplayManifest` types from `@mcpose/audit` for convenience.

## Documentation

- [Project README](https://github.com/amir-gorji/mcpose#readme): concepts, comparison, and guides
- [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit): the package these helpers verify
- [`CONTEXT.md`](https://github.com/amir-gorji/mcpose/blob/main/CONTEXT.md): the canonical domain glossary

## License

MIT © Amir Gorji
