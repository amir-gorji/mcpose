# Result _meta is stripped before it reaches the client

ADR-0008 closed the request direction: `params._meta` is stripped before it reaches the upstream.
The response direction had the same leak in reverse ([#81](https://github.com/amir-gorji/mcpose/issues/81)): mcpose forwarded upstream results verbatim, top-level `_meta` included, and the client is a third party to the upstream's correlation identifiers.
The SDK itself stamps `io.modelcontextprotocol/related-task` there, and a vendor upstream can attach tenant hints, internal trace ids, or anything else.
The same safe-default argument as ADR-0005 and ADR-0008 applies: a governance library must not leak metadata for someone who never read the manual.

`ProxyOptions.stripResultMeta` defaults to `true`: top-level `_meta` is removed from every result mcpose returns from the upstream (tool calls, resource reads, list and prompt calls) at the upstream boundary, inside the innermost `next`.
Stripping inside the innermost `next` rather than after the pipeline means middleware sees the stripped result, and any `_meta` middleware adds deliberately survives to the client.

## Scope exclusions

- Local tool results are not stripped: they have no upstream, so their `_meta` is the consumer's own and deliberate.
- Nested `_meta` is untouched: per-tool `_meta` in `tools[]` and per-block `_meta` in `content` are part of the advertised tool and content contract, not transport correlation.

## Considered Options

- **Keep forwarding and document the leak.** Rejected for the same reason as in ADR-0008: every consumer had to discover the leak on the wire, which is the cross-cutting concern mcpose exists to own.
- **Default off, opt-in strip.** Rejected: the population that most needs the strip does not know result `_meta` exists; an opt-in privacy control protects nobody by default.
- **An allowlist of `_meta` keys to forward.** Rejected: a key allowlist invites a slowly growing pass-through list whose privacy meaning nobody re-reviews.
- **Strip after the pipeline instead of at the upstream boundary.** Rejected: middleware would see and could log the identifiers the strip exists to contain, and middleware-added `_meta` would be stripped along with the upstream's.
- **A per-tool exemption via `passThroughTools`.** Rejected: pass-through selects which middleware runs; `stripResultMeta` governs what reaches the client. A privacy control a per-tool option could silently switch off would be the same false-confidence failure as the dispatcher bypass (ADR-0006), so the strip is uniform and can only be disabled globally.

## Consequences

- BREAKING: clients that read upstream-supplied result `_meta` keys stop receiving them until the consumer sets `stripResultMeta: false`. Ships in the next major.
- The SDK's `io.modelcontextprotocol/related-task` correlation is stripped along with everything else; deployments that rely on task correlation across the proxy set `stripResultMeta: false` and forward everything, which is the pre-existing behaviour.
- Every upstream result with a top-level `_meta` key allocates one shallow copy; results without `_meta` are passed through by reference.
