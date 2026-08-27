# Request _meta is stripped before it reaches the upstream

MCP clients send `params._meta`; VS Code in particular sends `progressToken`, a W3C `traceparent`, and `vscode/conversationId`.
mcpose forwarded `params` verbatim, `_meta` included, and the upstream is frequently a third party.
Those are internal correlation identifiers that link a third party's logs to a user's editor session; captured live on the upstream side of a production pilot ([#77](https://github.com/amir-gorji/mcpose/issues/77)).
For a library whose stated job is governance, leaking correlation metadata by default is the wrong default: a safe default must hold for someone who never read the manual, the same argument as ADR-0005.

`ProxyOptions.stripRequestMeta` defaults to `true`: `params._meta` is removed from every request mcpose forwards (tool calls, resource reads, list and prompt calls) at the proxy boundary, before the pipeline runs.
Stripping before the pipeline rather than at the innermost `next` means middleware sees the stripped request and can still add its own `_meta` deliberately, and audit hashes cover what is actually forwarded.

## The tradeoff

The documented functional cost of stripping `_meta` is losing upstream progress notification correlation.
In mcpose that cost is close to zero, because the proxy does not rely on the forwarded token: it reads the client's `progressToken` from the server-side request `extra`, passes its own `onprogress` to the upstream client, and the SDK then overwrites `params._meta.progressToken` with its own message id (`shared/protocol.js`).
Progress relay is therefore unaffected, and there is a test that proves it.

The residual cost is real but narrow: an upstream that reads other `_meta` keys, for example a vendor that expects a tenant hint or its own trace context, stops receiving them.
Those deployments set `stripRequestMeta: false` and forward everything, which is the pre-3.0.0 behaviour, or have middleware re-add the specific keys they mean to send.

## Considered Options

- **Keep forwarding and document the leak.** Rejected: every consumer proxying to an external service had to discover the leak on the wire and strip it by hand, which is the cross-cutting concern mcpose exists to own.
- **Default off, opt-in strip.** Rejected: the population that most needs the strip is the population that does not know `_meta` exists; an opt-in privacy control protects nobody by default.
- **An allowlist of `_meta` keys to forward (e.g. keep `progressToken`).** Rejected: the proxy does not need `progressToken` forwarded (see the tradeoff above), and a key allowlist invites a slowly growing pass-through list whose privacy meaning nobody re-reviews.
- **Strip at the innermost `next` instead of the boundary.** Rejected: middleware would then see and could log the identifiers the strip exists to contain, and a middleware-added `_meta` would be indistinguishable from the client's.
- **A per-tool exemption via `passThroughTools`.** Rejected: pass-through selects which middleware runs; `stripRequestMeta` governs what leaves the proxy. A privacy control that a per-tool option could silently switch off would be the same false-confidence failure as the dispatcher bypass (ADR-0006), so the strip is uniform and can only be disabled globally.

## Consequences

- BREAKING: upstreams that read client-supplied `_meta` keys stop receiving them until the consumer sets `stripRequestMeta: false` or re-adds specific keys in middleware. Ships in `mcpose` 3.0.0.
- The response direction is untouched: an upstream result `_meta` still reaches the client, which is part of [#81](https://github.com/amir-gorji/mcpose/issues/81).
- Every forwarded request with a `_meta` key allocates one shallow copy of `params`; requests without `_meta` are passed through by reference.
