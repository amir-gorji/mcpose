# Local tools route to their handler from inside the innermost next, so the full pipeline still applies

mcpose was strictly 1:1 with a single upstream: it could not expose a tool that mcpose itself implements.
Governance work regularly needs one, a redaction-aware summary, a composite call, a "why was this blocked" explainer, and the only way to add it was a hack: append the tool in `listToolsMiddleware` and intercept it in `toolMiddleware` without ever calling `next` ([#76](https://github.com/amir-gorji/mcpose/issues/76)).
That hack bypasses the pipeline's own invariants, audit and redaction included, and is easy to get wrong.

`ProxyOptions.localTools` accepts `{ tool, handler }` entries.
Local tools are overlaid inside the innermost `next` in both directions: `listToolsMiddleware` sees them exactly as it sees upstream tools, and a call to one runs its handler where the upstream call would have run, so the whole `toolMiddleware` pipeline, audit and redaction included, still applies.
They are added to the first page of a paginated list only, while the shadow filter runs on every page, so a paginating client sees each name exactly once.

Precedence is fixed and documented:

1. `hiddenTools` beats everything: a hidden local tool is filtered out of the list and rejected with `TOOL_HIDDEN`.
2. A local tool beats an upstream tool of the same name. The shadowing is deliberate, so a local tool can wrap or replace an upstream tool, and the client sees exactly one entry per name.
3. `passThroughTools` has no effect on a local tool: pass-through means "forward the upstream response as-is", and a local tool has no upstream, so it always runs the full pipeline.

The proxy advertises the `tools` capability when `localTools` is non-empty even if the upstream has none, and a `tools/call` for an unknown name against a tools-less upstream is rejected with `MethodNotFound` from inside the pipeline rather than being forwarded to an upstream that cannot serve it.
Two `localTools` entries with the same name throw at `createProxyServer`, since there is no correct way to pick one and silently keeping the last would route calls to a handler the configuration does not obviously name.

## Considered Options

- **Keep the list-middleware-plus-interception hack as the documented pattern.** Rejected: it silently skips the pipeline for the intercepted tool, which is the false-confidence failure ADR-0006 exists to remove.
- **Route local tools around the pipeline.** Rejected: a tool the proxy serves is exactly as much a governed call as a forwarded one; audit must record it and redaction must apply to it.
- **Let `passThroughTools` apply to local tools.** Rejected: pass-through selects which middleware runs for an upstream response; for a local tool it would mean "skip governance for code we wrote", a per-tool switch that silently disables controls.
- **Last-one-wins on duplicate names.** Rejected: routing calls to a handler the configuration does not obviously name is a debugging trap; failing at `createProxyServer` is cheap and unambiguous.
- **Multi-backend composition in the same change.** Deferred to [#80](https://github.com/amir-gorji/mcpose/issues/80): one governed endpoint over many upstreams raises namespace, degradation, and audit-boundary questions that need their own ADR.

## Consequences

- Additive: proxies without `localTools` behave exactly as before.
- A local tool's handler runs in-process with the proxy's own privileges; when it calls out to another system it does so with the proxy's credentials, not the client's. The attribution model for that is [#83](https://github.com/amir-gorji/mcpose/issues/83).
  That model is now defined in ADR-0011.
- The `tools` capability no longer implies the upstream has tools.
- `listChanged` is still advertised only when the upstream supports it; local tools are static per server instance.
