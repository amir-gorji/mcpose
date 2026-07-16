# Security Policy

mcpose is an audit and governance layer for MCP servers.
A core part of that promise is tamper-evident, compliance-grade audit trails, so we take security reports seriously.

## Supported versions

Only the latest minor release line receives security fixes.

| Version | Supported |
|---|---|
| 2.x | ✅ |
| < 2.0 | ❌ |

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Please report vulnerabilities privately, using either channel:

- Preferred: GitHub's private vulnerability reporting at
  `https://github.com/amir-gorji/mcpose/security/advisories/new`.
- Fallback email: `amir1gorji@gmail.com` with the subject `mcpose security report`.

Please include as much of the following as you can:

- A description of the issue and its impact.
- The exact version (or commit) you tested against.
- Steps to reproduce, or a proof of concept.
- Any affected package: `mcpose`, `@mcpose/audit`, or `@mcpose/testing`.

We will acknowledge your report within **3 business days** and aim to send an initial assessment within **7 days**.
We will coordinate a fix and disclosure timeline with you before publishing any details.

## Scope

In scope:

- The proxy core, transports, and middleware pipeline (`mcpose`).
- The audit chain, signing key derivation, encryption, and `ReplayManifest` (`@mcpose/audit`).
- The compliance assertions (`@mcpose/testing`).

Out of scope:

- Vulnerabilities in upstream MCP servers that mcpose merely proxies.
- Issues in dependencies that should be reported to the upstream maintainer.
- Theoretical attacks that require an attacker to already control the signing secret.

## Threat model and trust boundary

The cryptographic trust model is documented in [ADR-0003](./docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md).

Read it before reporting issues that touch:

- HMAC chain hash derivation or tamper-evidence.
- High-tier (AES-256-GCM) payload confidentiality.
- `ReplayManifest` Merkle roots and per-event proofs.
- `SigningKeyProvider` implementations and key handling.

Two invariants are load-bearing and must never silently break:

- The signing `keyId` is a **public identifier**, never key material.
- Per-entry chain keys and encryption roots are derived **through the `sign()` oracle**, not from `keyId`.

A report that demonstrates either invariant is bypassed is high severity.

## Hardening recommendations for operators

If you deploy mcpose in production:

- Generate the `AUDIT_SECRET` from a strong random source, never a reused password.
- In production, back the `SigningKeyProvider` with your KMS rather than the in-process HMAC provider.
- Treat high-tier audit payloads as sensitive at rest even though they are encrypted.
- Forward `ReplayManifest` artifacts to durable, append-only storage.
