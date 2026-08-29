# The delegation chain crosses the wire in request \_meta as unsigned attribution

Three deferrals pointed at one missing decision ([#117](https://github.com/amir-gorji/mcpose/issues/117)).
Core could not populate `ProxyContext.delegatedFrom` because no wire format existed for a chain to arrive in, loop prevention had no marker to read (ADR-0011), and `@mcpose/testing` could not assert chain continuity because continuity was undefined.
This ADR fixes the wire format, the trust model, and the continuity definition, so [#124](https://github.com/amir-gorji/mcpose/issues/124), [#125](https://github.com/amir-gorji/mcpose/issues/125), and [#126](https://github.com/amir-gorji/mcpose/issues/126) implement one spec instead of inventing three.

## The carrier

The chain travels in the request itself: `params._meta["mcpose/delegation"]`, on every request type that runs a pipeline.
`_meta` is MCP's extension point and exists identically on stdio and HTTP, so one mechanism covers both transports and a proxy chained behind another proxy.
An HTTP header was rejected: it is per-connection rather than per-call, cannot represent two interleaved delegation paths on one session, and does not exist on stdio at all.

The payload is versioned and minimal:

```json
{ "v": 1, "chain": [{ "sub": "agent-a", "type": "agent" }] }
```

Each entry carries `sub` (required, non-empty string) and `type` (`human` | `agent` | `service`), plus optional `displayName`, `resolvedAt`, and `source`.
Entries are oldest-first, matching `outboundDelegationChain()`.
`roles` and `claims` are deliberately absent from the wire format, and extraction ignores them if present.

## The chain is attribution, never authorization

Extraction maps each wire entry into an `Identity` with `roles: []` and `claims: {}`, unconditionally.
A wire chain is written by the previous hop and is attacker-influenced at the boundary, so nothing in it may ever grant a privilege: a chain that could carry roles would be a privilege-smuggling channel into every policy decision downstream.
Authorization comes only from the identity the proxy resolves itself (`resolveIdentity`), never from what a caller asserts about earlier hops.

Entries are not signed.
Per-hop signatures require key distribution between proxies that do not share an operator, which is infrastructure this product does not have and should not fake: an unverifiable signature field is worse than an honest trust statement.
The honest trust statement is transitive: a proxy trusts a presented chain exactly as much as it trusts the immediate caller it authenticated, who vouches for the history it forwards.
Once recorded, the chain is tamper-evident, because `delegatedFrom` is a covered field in the audit preimage; the unsigned span is only the hop between two proxies, which is already the span the transport trust covers.
A future signed scheme needs stable key discovery between proxies and belongs with the asymmetric-signer question recorded in ADR-0003; `@mcpose/testing` therefore asserts structural continuity, not signatures.

## Extraction, precedence, and ordering

Core reads the payload from the raw request before the ADR-0008 request-`_meta` strip runs, which is the boundary-ordering constraint ADR-0011 recorded: read first, strip second, or the marker never survives a chained proxy.
A host-provided `delegatedFrom` (stamped via `createProxyContext` or an identity resolver) takes precedence; core fills the field only when the host left it unset, so existing hosts that stamp their own chains see no behavior change and the extraction is additive.

On core's own forwarded calls, the outbound request to the backend carries `_meta["mcpose/delegation"]` rebuilt as `outboundDelegationChain(ctx)` serialized to the wire shape, whenever that chain is non-empty.
This closes the loop for chained proxies: the inbound strip removes the caller's copy, and core re-attaches the extended chain it can vouch for.
Local tool handlers keep the ADR-0011 contract: the host attaches `outboundDelegationChain(context)` itself, because outbound host code may not be MCP at all.

## Validation, loops, and DELEGATION_INVALID

A present-but-malformed payload rejects the call with `DELEGATION_INVALID` (`ErrorCode.InvalidRequest`), thrown inside the pipeline so audit records the attempt.
Malformed means: unknown `v`, `chain` not an array, more than 32 entries, an entry that is not an object, a missing or empty or non-string `sub`, or a `type` outside the union.
Silent dropping was rejected: an attribution channel that fails quietly produces trails that look complete and are not, the same failure mode ADR-0013 rejected for unroutable names.
An absent payload is not an error; `delegatedFrom` simply stays unset.

A chain is a loop when the sub of the proxy's own resolved inbound identity already appears in the presented chain: the authenticated caller is a link in the very history it presents, so the call has cycled.
Loop detection rejects with `DELEGATION_INVALID` after identity resolution and inside the pipeline, so the rejection is audited with the identity that tripped it.
On stdio with no resolved identity, only structural validation applies.
The 32-entry cap is input-bounding on a parsed payload, not the hop counter ADR-0011 rejected: it constrains what a proxy will parse, not what host outbound code does.

## Chain continuity, precisely

For `@mcpose/testing`, a recorded event's chain is continuous when all of the following hold:

- Every entry has a non-empty `sub`.
- Entry subs are pairwise distinct.
- The event's own `identity.sub` does not appear in `delegatedFrom`.

Order cannot be cryptographically verified without signatures, so continuity is structural, and the assertion says so in its documentation rather than overclaiming.

## Considered Options

- **An HTTP header (e.g. `mcpose-delegation`).** Rejected: per-connection not per-call, absent on stdio, and invisible to a host embedding the proxy in-process.
- **Full `Identity` objects on the wire, roles and claims included.** Rejected: turns the attribution channel into a privilege-smuggling channel; the receiving proxy would launder attacker-asserted roles into locally trusted objects.
- **Per-hop HMAC or asymmetric signatures now.** Rejected: no key-distribution substrate exists between independently operated proxies, and unverifiable signatures are decorative. Recorded as future work tied to ADR-0003's asymmetric-signer path.
- **Wire chain overrides a host-stamped one.** Rejected: the host is more trusted than the wire, and precedence any other way makes the extraction breaking instead of additive.
- **Dropping malformed chains silently.** Rejected: quiet failure in an attribution channel produces confidently wrong compliance evidence.
- **A configurable maximum chain depth.** Rejected for now: 32 is a parse bound, not a policy knob; a real depth policy belongs to the policy engine ([#118](https://github.com/amir-gorji/mcpose/issues/118)).

## Consequences

- [#124](https://github.com/amir-gorji/mcpose/issues/124) implements both directions of core's own path: inbound extraction before the strip, outbound re-attachment on forwarded calls.
- [#125](https://github.com/amir-gorji/mcpose/issues/125) implements the malformed-payload and loop rejections exactly as defined here.
- [#126](https://github.com/amir-gorji/mcpose/issues/126) asserts the structural continuity definition and documents that signatures are not part of it.
- A compromised or malicious immediate caller can still fabricate history; the trail records what an authenticated principal asserted, which is the same evidentiary standard as any unauthenticated claim a log records about its input. Operators needing stronger provenance need signed delegation, which is explicitly future work.
- `assertDelegationHonored`'s deferred signature claim in `packages/testing/README.md` is resolved by this ADR: continuity is structural in v3, and the README must say so when #126 lands.
