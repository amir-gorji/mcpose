# Prompt calls run a middleware pipeline and are audited as a new event kind

Tool calls ran the full middleware pipeline, so audit, hiding, and pass-through policy all applied to them.
Prompt calls ran no pipeline at all ([#104](https://github.com/amir-gorji/mcpose/issues/104)): 1:1 mode forwarded `prompts/get` straight to the backend, and mesh mode routed it by namespace with the `BACKEND_UNROUTABLE` rejection thrown from the raw handler.
ADR-0013 recorded the consequence and deferred it: audit never saw any prompt call, including a rejected routing attempt.

For a governance proxy sold on a tamper-evident trail that is a hole, not a gap.
A governed MCP server can carry sensitive data or instructions through a prompt, which crosses exactly the same trust boundary as a tool call, and the audit trail showed nothing.

The decision has two halves.

**Core gains `ProxyOptions.promptMiddleware`**, a `Middleware<GetPromptRequest, GetPromptResult>` array in response-processing order like every other `ProxyOptions` middleware array (ADR-0002).
It runs around every `prompts/get` in both 1:1 and mesh mode.
Mesh routing and the `BACKEND_UNROUTABLE` rejection moved inside the innermost `next`, the ADR-0007 pattern already used for hidden tools and tools-less upstreams, so an observing middleware records every prompt call and every rejection in-chain rather than watching the proxy reject one behind its back.

The pattern reaches exactly as far as the advertised capability allows.
A `prompts/get` handler can only be registered when the proxy advertises the `prompts` capability, because the SDK's `setRequestHandler` throws otherwise, and the proxy advertises it only when an upstream does.
So there is no prompts-less analogue of the tools-less handler: the tools-less case exists only because `localTools` can make the proxy advertise `tools` while no upstream serves them, and prompts have no local equivalent.
When no upstream advertises prompts, `prompts/get` is rejected by the SDK dispatcher before any handler exists, exactly as `tools/call` is on a proxy with neither upstream tools nor local tools.
An unaudited prompt call is therefore only possible against a proxy that advertises no prompts at all.
Request and result `_meta` stripping keep their existing boundaries: the request is stripped before the pipeline (ADR-0008) and the upstream result inside the innermost `next` (ADR-0009).

**The audit middleware gains a second middleware on its handle**, `promptMiddleware`, and audit events gain an optional `kind`.
`kind: 'prompt'` is present only on an event recorded for a prompt call, where `tool` holds the prompt name; an absent `kind` means a tool call.
Both middlewares are one implementation parameterized by that kind, because a tool call and a prompt fetch differ in nothing else the audit layer reads: both requests carry a name and optional arguments.
They share the session's state, so tool and prompt events interleave in a single chain and a single `ReplayManifest`, which is the point.
The tool middleware stays wrapped in `markPassThroughObserver`; the prompt middleware needs no wrapper, because there is no prompt pass-through concept to be exempt from.

## Adding `kind` is additive within format v2

`kind` is optional and written with the undefined-omission pattern in `chainPreimageFields()`, which is exactly the rule ADR-0012 wrote down.
An event recorded before prompts were audited has no `kind`, so `canonicalJson` omits the key and the event's preimage is byte-identical to what it was: every existing v2 chain and manifest still verifies.
A new prompt event carries `kind` inside the preimage, so post-hoc tampering with it, adding it, removing it, or changing its value, is detected by keyed verification at that index.
No domain label changes, and no major version of the format is required.
A **required** new field would have changed every preimage and triggered the full ADR-0004 v3 ritual instead.

## Considered Options

- **A separate prompt event type, or an `AuditEvent` union widened on a new discriminant.** Rejected: `AuditEvent` is already a union on `sensitivityTier`, and the chain, the Merkle tree, the manifest, and every verifier are written over one event shape. A second shape would fork all of that machinery to express one field of difference.
- **A distinct field for the prompt name instead of reusing `tool`.** Rejected: it would make `tool` optional, which changes the preimage for every event ever recorded, and every consumer that reads `tool` would need a second code path. Reusing `tool` with `kind` as the discriminator keeps old events and old readers correct.
- **A required `kind: 'tool' | 'prompt'` on every event.** Rejected for the same reason: a required field is a v3-class break for no gain, since absent already means tool unambiguously.
- **Auditing prompts by wrapping the backend client instead of adding a pipeline.** Rejected: it would see neither the mesh rejection, which never reaches a backend, nor the identity and session context that middleware receives, and it would leave prompts with no place to hang any future control.
- **Shipping `hiddenPrompts` and `passThroughPrompts` now.** Rejected as speculative: the pipeline is the mechanism those controls would be built on, and a name-array control for prompts has the same dispatcher-blindness ADR-0006 warns about. They land when a concrete requirement names their shape.
- **Giving `prompts/list` a pipeline in the same change.** Rejected for scope: list filtering is a catalog-egress control whose shape is set by ADR-0010 and the hidden-tools work, not by this issue, and the mesh list path merges across backends with its own degradation semantics.

## Consequences

- Prompt calls are recorded in the same tamper-evident chain as tool calls, rejections included, so the trail for a session is complete across both surfaces.
- Consumers that partition an audit trail by event type must read `kind`; anything that assumed every event was a tool call now sees prompt events too, which is the intended behavior change and the reason `kind` exists rather than being inferred.
- The sensitivity resolver receives prompt names in its `tool` argument, so an operator with a name-keyed map must add prompt names to it or accept the fail-closed `high` default. That default is safe, not silent: an unmapped prompt encrypts.
- Old v2 chains and manifests verify unchanged, and a verifier written against the pre-`kind` field set still verifies old events correctly, though it must add `kind` to reproduce the preimage of a prompt event.
- `prompts/list` still has no pipeline, so prompts cannot be hidden from a catalog yet; the closing of that gap now has a mechanism to build on.
- ADR-0013's consequence that an unroutable prompt is not audited is closed by this ADR.
