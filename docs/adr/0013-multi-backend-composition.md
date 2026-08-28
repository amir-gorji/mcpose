# One governed endpoint over many upstreams, with double-underscore namespacing and no inferred routing

`createProxyServer(backend, options)` took exactly one upstream ([#80](https://github.com/amir-gorji/mcpose/issues/80)).
An operator governing five MCP servers ran five proxies and five audit trails, and a client needing tools from two of them held two connections.
ADR-0007 shipped `localTools`, the other half of the same idea, and deferred this one because namespacing, degradation, and the audit boundary needed their own decision.

`createProxyServer` now accepts either form.
A `BackendClient` is the existing 1:1 proxy, behaviour completely unchanged, no namespacing anywhere.
A `Record<string, BackendClient>` is **mesh mode**: the record keys are **backend keys**, and every upstream tool and prompt is exposed as `<backendKey>__<name>`.

Backend keys are validated at `createProxyServer`: an empty record, an empty key, or a key containing `__` throws.
Because a key can never contain the separator, the first `__` in an exposed name always splits key from upstream name, even when the upstream name contains one itself.

**A tool call that does not route fails loudly.**
An un-namespaced name, an unknown prefix, or a prefix naming a backend without a `tools` capability is rejected with `MethodNotFound` and the new `BACKEND_UNROUTABLE` rejection reason.
For a tool call that rejection is thrown inside the pipeline, so audit records it like any other rejection.
There is no "resolve it if only one backend has that name" fallback: a mesh that silently re-routes a call when a backend is added is exactly the failure a governance proxy must not have.

**Configuration stays global and matches the namespaced name.**
`hiddenTools`, `passThroughTools`, the middleware arrays, and everything else in `ProxyOptions` are unchanged and see `<key>__<tool>`.
Per-backend expressiveness falls out of the prefix, so no per-backend configuration mechanism ships: `hiddenTools: ['crm__delete_account']` hides one tool on one upstream, and a `HiddenToolPredicate` can match a whole backend with `name.startsWith('crm__')`.

**A partially available mesh degrades.**
`tools/list` and `prompts/list` query every backend concurrently and isolate failures: a backend that throws contributes nothing and the live backends' entries are still returned.
The degradation is reported as a `backend_degraded` telemetry event naming the key, the method, and the error.
A call routed to a down backend fails only that call.

Isolation covers runtime failures, not startup.
A backend whose `getServerCapabilities()` returns `undefined` was never connected, and every entry is checked at `createProxyServer`, which throws and names the offending key.
That is the same programming-error check a 1:1 proxy has always made, and it stays loud on purpose: an unconnected client in the record is a wiring mistake, not an upstream having a bad day, and degrading it away would hide a proxy that can never serve those tools at all.

**One audit session spans the mesh.**
The middleware pipeline is untouched and still runs exactly once, around whichever backend the call routes to.
Per-event backend attribution already falls out of the namespaced `tool` field plus the ADR-0012 `proxy` field, so nothing in `packages/audit` changes, there is no new identity model, and `delegatedFrom` semantics are exactly as ADR-0011 left them.

**Local tools are not namespaced**, because they belong to the proxy rather than to any upstream.
ADR-0007 precedence is unchanged and now reads against exposed names: `hiddenTools` beats a local tool, and a local tool named `crm__lookup` shadows the upstream tool exposed under that name.
Capabilities are the union across backends, plus the ADR-0007 rule that a non-empty `localTools` advertises `tools` on its own.
`listChanged` is advertised when any backend advertises it, and every backend's notification is forwarded to every connected proxy server, so the fan-in reuses the existing per-backend bus with no new machinery.
That bus now registers its handlers from the backend's own capabilities and filters at fan-out by what each subscribed server advertises, because a backend shared between a mesh and a 1:1 proxy would otherwise be frozen with whichever proxy created the bus first, and could hand a mesh server a notification for a surface the mesh never advertised.

## What this ADR settles beyond the tool surface

**Prompts are namespaced exactly like tools.**
Prompt names are plain strings, so `<key>__<name>` and prefix routing apply unchanged, with the same loud failure and the same degradation on list.
The prompt rejection carries the same `BACKEND_UNROUTABLE` reason but is thrown from the raw handler, because prompts are forwarded as-is and there is no prompt pipeline to throw inside.
Audit therefore never sees an unroutable prompt, exactly as it never sees any other prompt call; closing that gap means giving prompts a pipeline, which is out of scope here.

**Resources are not exposed in mesh mode.**
A resource is addressed by URI, and a URI is not a name: prefixing `file:///notes.md` breaks it, and a wrapper scheme such as `mcpose+crm://` would rewrite an identifier that clients, upstreams, and audit records all treat as opaque.
Routing `resources/read` by which backend happened to list a URI is the inference this ADR rejects for tools.
So mesh mode advertises no `resources` capability, and a resource request against a mesh gets `MethodNotFound`.
A single-backend proxy is unaffected.
Mesh resource composition is deferred to [#100](https://github.com/amir-gorji/mcpose/issues/100).

**Mesh list responses are unpaginated.**
Cursors are opaque and per-backend, so there is no cursor that means "page 3 of the union".
Mesh mode drains every backend's pages and returns one complete page with no `nextCursor`; a cursor sent by a client is ignored, and local tools are therefore always present.
A backend that never finishes paginating is cut off after 100 pages and reported as a degradation, because a governance proxy must not hang on a misbehaving upstream.
Single-backend pagination is untouched and still forwards the upstream's cursors verbatim.
Mesh list calls also forward only a cursor, dropping the rest of the outbound request params, so a `ListToolsMiddleware` that rewrites the request it passes to `next` still shapes the merged response but no longer reaches the upstreams, unlike in 1:1 mode.

**`TelemetryEvent` becomes a discriminated union** on the `type` field it already carried, gaining `backend_degraded` alongside `tool_call`.
Degradation is an observability signal, so it belongs on the observability hook rather than on a second one.
Consumers that hold a `TelemetryEvent` and read `tool_call` fields now need to narrow on `type` first.

## Considered Options

- **A single-dot or slash separator.** Rejected: `.` and `/` both occur in real MCP tool names, so the split would be ambiguous; `__` is rare inside a name and unambiguous once keys are forbidden from containing it.
- **Resolve an un-namespaced name when exactly one backend offers it.** Rejected: it is correct until a second backend is added, at which point a working call either breaks or silently re-routes. Compatibility for a hardcoded client is a `localTools` alias the operator writes down, not an inference the proxy makes.
- **Per-backend `hiddenTools` / middleware / pass-through config.** Rejected: the prefix already expresses everything a per-backend option would, and a second place to configure a control is a second place to get it wrong.
- **Fail the whole `tools/list` when any backend is down.** Rejected: one unhealthy upstream would take down every other governed tool, which is worse for the operator than a reported gap.
- **One audit session per upstream.** Rejected: it would fragment the trail the mesh exists to unify, and it needs no new attribution because the namespaced tool name already names the backend.
- **Namespace local tools too.** Rejected: a local tool has no upstream, so there is no key to name it with, and ADR-0007's shadowing rule depends on a local tool being able to take an exposed name.
- **A composite `BackendClient` facade passed to the existing single-backend path.** Rejected: `BackendClient` is the SDK `Client` class, so a facade needs an unsound cast, and one built per HTTP session would re-register each upstream's notification handlers and break the fan-out to earlier sessions.
- **A dedicated `onBackendError` option instead of a telemetry event.** Rejected: it avoids widening `TelemetryEvent` at the cost of a second observability hook that every sink then has to wire separately.

## Consequences

- Additive for every existing proxy: passing a `BackendClient` behaves exactly as before, including pagination, resources, and the plain `MethodNotFound` for a tools-less upstream.
- Clients that hardcoded an upstream tool name must be updated for mesh mode, and get a clear `BACKEND_UNROUTABLE` rejection until they are.
- A degraded mesh is invisible without an `onTelemetry` sink, so an operator running a mesh should wire one.
- Backend keys become part of the public contract of a proxy: renaming one renames every tool the client sees.
- Mesh mode cannot serve resources, and a proxy that needs them stays 1:1 until #100 lands.
- A `ListToolsMiddleware` that rewrites the outbound list request is inert in mesh mode, because only the cursor is forwarded.
- An unroutable prompt is not audited, because prompts have no pipeline to reject inside.
