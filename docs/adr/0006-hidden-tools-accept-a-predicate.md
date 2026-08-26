# hiddenTools accepts a predicate so a dispatcher cannot reach a hidden tool by name

`hiddenTools` was `ReadonlyArray<string>` matched against `req.params.name` only.
Several upstream MCP servers expose a dispatcher, a meta-tool that takes the real tool name as an argument, for example Sentry's `execute_sentry_tool({ name, arguments })`.
Hiding `update_issue` did nothing there: `execute_sentry_tool({ name: 'update_issue', ... })` passed straight through with a name that was not on the list ([#75](https://github.com/amir-gorji/mcpose/issues/75)).
A blocklist that silently fails to block is worse than no blocklist, because it manufactures false confidence; the pilot consumer had to hand-write middleware to unwrap the target name and re-check it, which is exactly the cross-cutting concern mcpose exists to own.

`hiddenTools` now accepts `ReadonlyArray<string> | HiddenToolPredicate`, where the predicate is `(name, args) => boolean`.
The `args` argument carries the phase, which avoids a third parameter: it is `undefined` during list filtering, because a listed tool has no arguments, and always an object at call time, empty when the client sent none.
That distinction is what lets a predicate keep a dispatcher visible in `tools/list` while still failing closed on a dispatcher call whose target argument is missing.
`dispatcherAwareBlock({ tools, dispatchers, argPath })` ships with the core package for the common case and blocks whenever the resolved target is not a string, including a dotted `argPath` that traverses a non-object, an array, or a prototype key such as `constructor`.

The predicate is authoritative in both places the array already was: list responses are filtered before and after `listToolsMiddleware`, and a blocked call is rejected inside the pipeline with `TOOL_HIDDEN`, so audit middleware records the attempt and the upstream is never called.

## Considered Options

- **Keep the array and document the bypass.** Rejected: documentation does not remove the false confidence, and every consumer fronting a dispatcher-shaped upstream would re-implement the same unwrapping middleware.
- **A declarative dispatcher config only, without the predicate.** Rejected: `dispatcherAwareBlock` covers the observed shape, but upstreams nest the target arbitrarily (`request.tool.name`) and invent new shapes; the predicate is the escape hatch that keeps core out of the schema-guessing business.
- **Inspect arguments during list filtering too.** Rejected: a listed tool has no arguments, so the extra parameter would always be `undefined` noise; encoding the phase in `args` keeps the signature honest.
- **Fail open when the dispatcher's target argument is malformed.** Rejected: a caller who controls the arguments controls the malformation; failing open would reopen the bypass through a `null` or object-shaped target.

## Consequences

- Additive: existing array configurations keep working unchanged.
- A predicate runs on every `tools/list` entry and every `tools/call`; it should be cheap and must be side-effect free.
- The `hiddenResources` option is unchanged; resources have no dispatcher pattern in the wild to close.
- `SECURITY.md` documents the dispatcher bypass explicitly, including the fact that a name-only blocklist cannot see through a meta-tool.
