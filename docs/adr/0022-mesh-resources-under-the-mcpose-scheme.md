# A mesh exposes upstream resources under `mcpose://<backendKey>/<uri>` and routes reads by that prefix alone

ADR-0013 shipped multi-backend composition for tools and prompts and left resources out of mesh mode: a mesh advertised no `resources` capability, and `resources/list` and `resources/read` answered `MethodNotFound` ([#100](https://github.com/amir-gorji/mcpose/issues/100)).
The reason was sound as far as it went.
A resource is addressed by URI, not by name; prefixing `file:///notes.md` with `crm__` breaks it, and routing a read by which backend happened to list the URI is the inference ADR-0013 rejects for tools, because two backends can serve the same URI and a resource template can name one no list ever returned.

From `mcpose` 3.0.0, a mesh serves resources.
Every URI a backend lists is exposed as `mcpose://<backendKey>/<uri>`, with the upstream URI appended verbatim.
`resources/read` accepts only that form: the fixed prefix is stripped, the key selects the backend, and the remainder is forwarded untouched.
Anything else, an unwrapped URI, an unknown key, a key naming a backend without a `resources` capability, or an empty remainder, is rejected with `InvalidRequest` and the existing `BACKEND_UNROUTABLE` reason, thrown inside the resource pipeline so an observing middleware records it.
`hiddenResources` and `passThroughResources` match the exposed URI, exactly as `hiddenTools` matches the namespaced name.
`resources/list` drains every backend into one unpaginated page and degrades per backend with a `backend_degraded` telemetry event whose `method` is `resources/list`, as the other two list surfaces already do.

## Why a wrapper after all

The objection to a wrapper was that it rewrites an identifier every party treats as opaque.
Looked at per party, that does not hold.
The upstream never sees the wrapped form: the prefix is stripped before the read is forwarded, so the upstream serves exactly the URI it listed.
The client receives one valid URI whose meaning is "read me through this proxy", which is all a resource URI ever means to a client, and the MCP specification places no semantics on a scheme a client does not recognise.
And the audit trail records what the client asked for, which is what it already does for a tool call: the namespaced `crm__lookup`, never the upstream `lookup`.
The wrapped URI is the resource analogue of the namespaced name, and it is the same public contract ADR-0013 already made the backend key part of.

The wrapper also settles the two questions that made inference unsafe.
Two backends serving the same URI never collide, because each is under its own prefix.
A template's `uriTemplate` wraps like any other URI, so a client expanding `mcpose://crm/file:///{path}` produces a URI that routes without any list having returned it.
The proxy does not forward `resources/templates/list` or subscriptions today in either mode, so that is the shape they will take when they land rather than a change made here.

## Why this shape of wrapper

The key sits in the authority and the upstream URI is the path, rather than the key being spliced into the scheme as `mcpose+crm:` or the URI being percent-encoded into a query.
The original is recovered by slicing off a fixed prefix; it is never parsed, so a `?` or `#` inside it survives round-trip.
A URL parser on the client side accepts the form too, which the `__` separator would not: underscores are not scheme characters, and `crm__file:` throws in a WHATWG parser.

That constrains the key.
A backend key was previously any non-empty string without `__`; it is now an identifier, `[A-Za-z0-9][A-Za-z0-9._-]*`, which is what both a tool name and a URI host accept.
Keys in practice were already identifiers, and the release has not shipped, so the contract tightens rather than breaks.

## What changed alongside

The list-changed fan-out no longer filters per surface.
That filter existed for one case, a mesh sharing a backend with a 1:1 proxy while advertising no `resources`; every proxy now advertises the union of its backends' surfaces, so the case is gone and the filter with it.

## Considered Options

- **Keep resources out of mesh mode.** Rejected: a mesh whose upstreams serve resources was forced back to five proxies and five audit trails for that surface alone, which is the fragmentation ADR-0013 exists to remove.
- **Route by which backend listed the URI.** Rejected, as in ADR-0013: correct until two backends serve the same URI, and blind to templates.
- **An operator-configured URI prefix per backend.** Rejected: it asks the operator to know each upstream's URI space, cannot express two backends sharing a scheme, and gives a template whose expansion does not match its declared prefix nowhere to go. The wrapper needs no configuration and cannot collide, which is the same reason the `__` prefix carries no per-backend configuration.
- **A backend selector in `_meta` with the URI left bare.** Rejected: clients do not carry list-item metadata into read requests, so it only works for a client written against this proxy.
- **`mcpose+<key>:<uri>`, the key in the scheme.** Rejected: scheme characters exclude `_`, so it would forbid keys the tool prefix accepts, and the composite scheme reads as one word where the authority form reads as the two parts it is.
- **Percent-encode the upstream URI.** Rejected: it makes the exposed URI unreadable, and a template's `{param}` would be encoded into inertness.

## Consequences

- A mesh advertises `resources` when any backend does, with `listChanged` when any backend has it, and forwards every backend's `resources/list_changed`.
- `BackendDegradedTelemetryEvent.method` gains `'resources/list'`. `@mcpose/otel` records the method as an attribute and needs no change.
- Backend keys must be identifiers. A record with a key containing a space, slash, colon, or other non-identifier character throws at `createProxyServer`.
- The exposed URI is part of the proxy's public contract with the same force as the namespaced name: renaming a backend key renames every resource the client holds.
- ADR-0013's "mesh mode cannot serve resources" consequence is closed.
