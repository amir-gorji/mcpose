# AGENTS.md

Canonical rules for any agent or human working in this repository.

## Orientation

mcpose is a pnpm 11 + Turborepo monorepo publishing three ESM-only packages: `packages/core` (`mcpose`, the proxy pipeline), `packages/audit` (`@mcpose/audit`, the tamper-evident audit chain), and `packages/testing` (`@mcpose/testing`, compliance assertions).
`examples/` is a private workspace that is type-checked but never published.
Read [`CONTEXT.md`](./CONTEXT.md) for the domain vocabulary before naming anything, [`README.md`](./README.md) for what the product does, and [`docs/adr/`](./docs/adr) for the decisions that must not drift silently.
[`CONTRIBUTING.md`](./CONTRIBUTING.md) covers documentation style and PR expectations.

## Setup

Node.js 20 or newer, pnpm 11 (the workspace pins `pnpm@11.0.8`).

```bash
pnpm install
```

`pnpm install` also runs `prepare`, which points `core.hooksPath` at `.githooks/`.
If the git hooks are not firing, run `pnpm install` again.

## The gates

Run them in this order from the repository root.
This is exactly the `.githooks/pre-push` chain, so a clean local run means a clean CI run.

```bash
pnpm format:check   # prettier 3.9.6; `pnpm format` writes
pnpm build          # turbo run build (tsc per package)
pnpm lint           # eslint 10 flat + typescript-eslint type-aware; `pnpm lint:fix` writes
pnpm ts:ci          # tsc 6.0.3 --noEmit against the hardened tsconfig.base.json
pnpm test           # vitest run --coverage, per-package ratcheted thresholds
pnpm knip           # unused files, exports, and dependencies
pnpm check:publish  # publint + attw --pack --profile esm-only
```

`pnpm lint` and `pnpm ts:ci` need `pnpm build` first: type-aware linting resolves cross-package types from the emitted `.d.ts`.

Mutation testing is the one gate that is deliberately outside that chain, because a full run takes minutes rather than seconds.

```bash
pnpm --filter @mcpose/audit mutation   # stryker run, packages/audit
pnpm --filter mcpose mutation          # stryker run, packages/core
```

Stryker mutates in place rather than in a sandbox, because a sandbox copy breaks the relative `extends` in each package `tsconfig.json`.
A completed run restores the originals, but a killed run can leave mutated sources behind, so check `git status` before trusting the working tree after an interrupted run.

Which layer enforces what:

| Gate | Per-edit hook | pre-commit | pre-push | CI |
|---|---|---|---|---|
| prettier | yes, blocking, per `.ts` file | yes, staged files only | yes | yes |
| eslint | yes, blocking, per `.ts` file | no | yes | yes |
| build / ts:ci / test / knip / check:publish | no | no | yes | yes |
| gitleaks, osv-scan | no | no | no | yes |
| mutation (stryker) | no | no | no | separate lane: push to main, paths-filtered, plus workflow_dispatch; ratcheted `thresholds.break` |

The per-edit layer is the Claude Code `PostToolUse` hook in [`.claude/hooks/ts-quality.sh`](./.claude/hooks/ts-quality.sh): it runs `prettier --write` then `eslint --fix` on every `.ts` file an agent edits and blocks the tool result on failure.
CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) runs the whole chain on a Node 20 / 22 / 24 matrix, plus gitleaks and osv-scan, with all actions SHA-pinned.
The mutation lane ([`.github/workflows/mutation.yml`](./.github/workflows/mutation.yml)) is a separate workflow, so the pre-push chain still matches the `ci.yml` matrix exactly.
It runs on pushes to `main` that touch `packages/audit/**`, `packages/core/**`, a Stryker config, or the workflow itself, and on `workflow_dispatch`.
There is no cron: a nightly run would re-mutate unchanged code for no new information, and GitHub disables schedules on quiet repositories.
Because it only reports after a merge, run it locally before landing a change that reshapes test assertions in either package.
`git push --no-verify` is the emergency escape hatch and is not a normal workflow.

## Policies

**Coverage thresholds are raise-only ratchets.**
They live in each `packages/*/vitest.config.ts`.
Raising one is routine; lowering one needs ADR-level justification in the PR.
Thresholds are Node-version-sensitive and are set from the cross-version worst case, so a number that passes locally on one Node can still fail the matrix.
The same rule governs `thresholds.break` in each `packages/*/stryker.config.mjs`, set to the measured mutation score rounded down minus two points.

**Tooling devDependencies are exact-pinned.**
`prettier`, `eslint`, `typescript`, `publint`, `@arethetypeswrong/cli`, `knip`, and `typescript-eslint` carry exact versions with no range prefix.
Keep it that way: a floating tool version turns a deterministic gate into a flaky one.

**`overrides` in `pnpm-workspace.yaml` pin vulnerable transitive dependencies.**
Do not widen or remove an override without checking osv-scan first.
The osv-scan CI job is the authority on whether a range is safe.

**Turbo may serve a stale cache after config edits.**
See [issue #65](https://github.com/amir-gorji/mcpose/issues/65).
While iterating on `tsconfig.base.json`, an `eslint.config.mjs`, or a `vitest.config.ts`, bypass turbo and run the tool directly per package (`pnpm --filter mcpose exec tsc --noEmit`).
Verify the final state through the normal `pnpm` scripts.

## Hard rules for packages/audit

Changes to `packages/audit` and `packages/testing` must be behavior-neutral refactors unless the issue explicitly asks for a behavior change.
The failure mode is silent: a change can compile, pass every test, and still void the cryptographic guarantee.

Before touching the HMAC chain, key or subkey derivation, encryption, canonical serialization, or the `ReplayManifest`, read all three of:

- The `mcpose-audit-invariants` skill in [`.claude/skills/`](./.claude/skills/mcpose-audit-invariants/SKILL.md).
- [ADR-0003](./docs/adr/0003-audit-subkeys-derived-from-signing-oracle.md), on subkeys derived from the signing oracle.
- [ADR-0004](./docs/adr/0004-audit-format-v2-canonical-serialization.md), on canonical serialization.

Never weaken an existing audit assertion to make a test pass.
A failing assertion is the signal that the change broke tamper-evidence, not a test to be adjusted.

## Conventions

**Commit messages must reference the GitHub issue id**, for example `Add AGENTS.md as the canonical rules file (#58)`.
Write them in the imperative mood.

**No `Co-Authored-By` lines and no agent attribution of any kind** in commit messages or PR bodies.

**Markdown prose is one sentence per physical line**, and no em dashes anywhere.
Prettier ignores `*.md` on purpose, so no formatter will fix markdown for you: write it clean by hand.

**ESM-only.**
Never add a CJS build, a `require` entry point, or a dual-export condition.
`check:publish` runs attw with `--profile esm-only` and will reject it.

**No new runtime dependencies without explicit maintainer approval.**
A few lines of code beat a new entry in `dependencies` almost every time.
New devDependencies for tooling are lower stakes but still need a reason in the PR.

**Update documentation alongside behavior changes**, and add an ADR when a decision is non-obvious or reverses a prior one.

**Adding a new gate?**
Add it to the gate list and the enforcement table above in the same PR that lands it.
