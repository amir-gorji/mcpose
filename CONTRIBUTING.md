# Contributing to mcpose

Thanks for considering a contribution.
mcpose is a transparent middleware proxy for MCP servers with a compliance-grade audit trail, so a few conventions keep the codebase healthy and trustworthy.

This document covers setup, the common commands, the domain conventions, and what a good pull request looks like.

## Project layout

This is a pnpm + Turborepo monorepo.

| Path | Contents |
|---|---|
| `packages/core` | The `mcpose` package: proxy pipeline, transports, identity, governance. |
| `packages/audit` | The `@mcpose/audit` package: HMAC audit chain, Merkle `ReplayManifest`, sensitivity tiers. |
| `packages/testing` | The `@mcpose/testing` package: runner-agnostic compliance assertions. |
| `apps/` | Internal demo and sandbox applications. |
| `docs/adr/` | Architecture Decision Records. |
| `CONTEXT.md` | The ubiquitous-language glossary for the domain. |
| `knowledge/` | Reference notes on documentation and project conventions. |

## Prerequisites

- Node.js 18 or newer (CI runs on Node 22).
- pnpm 11.x (the workspace pins `pnpm@11.0.8`).
- A git checkout of this repository.

## Setup

Clone the repository and install dependencies from the root:

```bash
git clone git@github.com:amir-gorji/mcpose.git
cd mcpose
pnpm install
```

The install is workspace-aware and wires the local packages together via `workspace:*`.

## Common commands

All commands run from the repository root.
Turborepo caches results and only re-runs what changed.

```bash
pnpm build      # Build every package (tsc) into dist/
pnpm test       # Run the vitest suite across every package
pnpm ts:ci      # Type-check every package with --noEmit
```

To run a command for one package only:

```bash
pnpm --filter mcpose test
pnpm --filter @mcpose/audit build
```

Each package also exposes `ts:ci`, `test`, and `build` scripts directly.

## Domain conventions

Two documents encode decisions that should not drift silently.

- [`CONTEXT.md`](./CONTEXT.md) is the ubiquitous-language glossary.
  Reuse the terms it defines (`ProxyContext`, `Identity`, `AuditEvent`, `ReplayManifest`, `SensitivityTier`) rather than inventing synonyms.
- [`docs/adr/`](./docs/adr) holds the Architecture Decision Records.
  Read the ADRs that touch the area you are changing before you start.

### Audit invariants

The `@mcpose/audit` tamper-evidence guarantees are load-bearing.
If your change touches the HMAC chain, key derivation, encryption, the `ReplayManifest`, or the compliance assertions, it must not silently break those invariants.
See [ADR-0003](./docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md) and the [`SECURITY.md`](./SECURITY.md) trust-model section.

### Tests and types

- Every package type-checks clean with `pnpm ts:ci`.
- Add or update tests under the package you change.
  The suite runs with vitest and uses `@mcpose/testing` for compliance assertions.
- Do not weaken an existing audit assertion to make a test pass.
  If an assertion fails, treat it as a signal that the change may break tamper-evidence.

## Writing a good change

- Keep pull requests focused on one concern.
- Run `pnpm ts:ci` and `pnpm test` before pushing.
  CI runs the same two checks, so a green local run means a green CI run.
- Update documentation alongside behavior changes.
  If you add or rename a public API, update the root `README.md` and the relevant package README.
- Add an ADR when a decision is non-obvious or reverses a prior choice.
  Number the next file sequentially under `docs/adr/`.

## Documentation conventions

The project follows a few markdown conventions that keep the docs consistent and reviewable.
The [`knowledge/`](./knowledge) directory has reference notes on the documentation philosophy if you want the full context.

### Prose style

**One sentence per physical line.**
Put each sentence on its own line.
Preserve normal markdown structure (headings, lists, code fences, tables), but do not wrap multiple sentences onto one line.
This keeps diffs clean: a changed sentence shows as one line changed, not one paragraph reflowed.

**No em dashes.**
Use colons for label/separator roles, commas for mid-sentence parentheticals, semicolons for sentence connectors, and periods for full stops.
A plain dash (`-`) is fine in prose when it acts as a hyphen.

### Folding dense reference with `<details>`

When a section contains a large code block that would overwhelm the scan, fold it behind a `<details>` block.
The heading and a one-line lead-in stay visible so anchors and navigation still work.

The reliable pattern for a folded fenced code block:

```markdown
### Heading

One-line summary of what is folded.

<details>
<summary>Show the details</summary>

```ts
// code block here
```

</details>
```

The blank line after `</summary>` and before `</details>` is load-bearing.
Without it, the markdown processor may not render the fenced code inside the HTML block.

**Rule of thumb:** fold TypeScript type definition blocks that span more than ~10 lines.
Keep short, high-value entry points (the Quick Start, key function signatures, the API table) fully expanded.

### Package README template

Every package README follows the same structural template so readers know where to find things across packages:

1. Title with npm, license, TypeScript, and CI badges
2. One-line bold description (the npm tagline)
3. "When to reach for it" section (audience framing)
4. Features section (benefit-oriented bullets)
5. Table of Contents (if the README exceeds ~80 lines)
6. Install
7. Quick start
8. Core concepts or How it works
9. API surface (table + key types)
10. Documentation links (root README, ADRs, CONTEXT.md)
11. License

New packages should follow this template.
Existing packages should not regress from it.

### Anchor links

GitHub auto-generates heading anchors from heading text.
The slugger keeps underscores and letters, strips punctuation (`.`, `:`, `@`, `/`, `+`), and replaces spaces with hyphens.
Always verify that TOC entries resolve against the actual rendered anchors before opening a PR.

### Checking your work

Before opening a documentation PR:

- Run `grep -n '—' **/*.md` from the repo root and confirm zero matches.
- Verify every relative link resolves (GitHub will red-underline broken ones in the PR diff).
- Confirm the TOC anchors match the heading slugs.
- Re-read the changed file as a first-time visitor: does the section order make sense? Are the code snippets runnable?

## Commit and pull request style

- Write commit messages in the imperative mood ("Add mTLS option", not "Added mTLS option").
- Reference the issue number in the PR description when one exists.
- The PR template lists the checklist the maintainer will review against.

## Reporting issues

Open a GitHub issue for bugs and feature requests.
For anything security-sensitive, follow [`SECURITY.md`](./SECURITY.md) instead of opening a public issue.

## Code of conduct

Participation in this project is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
By contributing, you agree to uphold it.
