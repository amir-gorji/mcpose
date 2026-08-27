# Proxy-originated outbound calls carry the inbound delegation chain, stamped by the host

A local tool's handler runs in-process and calls out to other systems with the proxy's own service credentials, not the inbound caller's ([#83](https://github.com/amir-gorji/mcpose/issues/83)).
ADR-0007 named that gap: without a defined attribution model, an outbound call looks like the proxy acting for itself, and the caller who triggered it disappears from downstream logs.

The attribution model: a proxy-originated outbound call is made with the proxy's own service credentials acting on behalf of the inbound caller.
The chain attached to the outbound call is `outboundDelegationChain(ctx)`: the inbound `delegatedFrom` chain oldest-first, with the inbound `identity` appended.
The inbound audit event already records `identity` and `delegatedFrom`, so the audit side is complete as-is.

Core exposes the chain; the host attaches it to outbound credentials, headers, or context, because only the host knows the outbound protocol.
The helper returns a fresh array and never mutates or aliases `ctx.delegatedFrom`, because the audit middleware reads the same context object when building the inbound event, and pre-extending it would misrecord the inbound call's chain.

Loop prevention is deferred to the v3 delegation spec.
It records the ADR-0008 constraint now: any `_meta`-borne loop marker must be read at the proxy boundary before the request-`_meta` strip runs, or it never survives a chained proxy.
No hop counter ships now: it could only cover core-forwarded calls, not host-code outbound calls, exactly the false-confidence partial control ADR-0006 warns against.

No core per-call timeout option ships either.
The handler-side one-liner covers it: `AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)].filter((s) => s !== undefined))`.
A core race could reject the call but cannot cancel the handler's underlying work.

## Considered Options

- **Core auto-extends `ctx.delegatedFrom` before invoking a local tool handler.** Rejected: the audit middleware reads the same context object for the inbound event, so the mutation would misrecord the inbound call's chain.
- **An attributing MCP-client wrapper for outbound calls.** Rejected: speculative, and outbound is protocol-agnostic host code that may not be MCP at all.
- **A hop counter now.** Rejected: it covers only core-forwarded calls, not host-code outbound calls, which is the false-confidence partial control ADR-0006 warns against.
- **A core `localToolTimeoutMs` option.** Rejected: it is one line of host code with `AbortSignal`, and a core-side race cannot cancel the handler's underlying work anyway.

## Consequences

- Hosts that make outbound calls from local tool handlers must attach `outboundDelegationChain(context)` themselves; core cannot verify they did.
- The inbound audit record needs no change: attribution for the outbound direction reuses what it already captures.
- The v3 delegation spec inherits the boundary-ordering constraint on any `_meta`-borne marker.
