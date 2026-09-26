# A resumed session replays the client's initialize into a fresh transport, and carries its deadline with it

`startHttpProxy` kept its sessions in an in-memory map.
`@mcpose/store-redis` and `@mcpose/store-postgres` made SSE replay history durable, but a client reconnecting to a restarted proxy, or to another instance behind a load balancer, was rejected on its `mcp-session-id` before the event store was ever consulted ([#155](https://github.com/amir-gorji/mcpose/issues/155), found while landing [#129](https://github.com/amir-gorji/mcpose/issues/129)).
The missing half was a shared record of live sessions.

From `mcpose` 3.0.0, `HttpProxyOptions.sessionRegistry` takes a `SessionRegistry`: `set`, `get`, and `delete` over a plain-JSON `SessionRecord` holding the client's `initialize` params verbatim, the resolved `Identity`, and the session's deadline as an absolute timestamp.
Both store packages implement it beside their `EventStore`.

## Why replay the initialize

The SDK's `StreamableHTTPServerTransport` accepts a session id only once it has handled an `initialize` request: that is where it assigns the id, flips its private initialized flag, and where the `Server` behind it learns the client's protocol version, capabilities, and client info.
There is no public way to hand a transport an existing session.

The registry therefore stores what the client sent, and a resuming instance builds a fresh transport with a `sessionIdGenerator` that returns the stored id, then drives it through the SDK's own request path with a synthetic POST carrying those params.
The SDK does the rest exactly as it did the first time, so the rebuilt session negotiates what the original did, and the SDK's `Host` and `Origin` checks run against the headers of the request being resumed.
If the SDK refuses the replay, its answer is relayed to the client, because the real request would have failed the same check.

The synthetic request is an `http.IncomingMessage` on an unconnected socket, with the body pushed in and the response captured instead of written.
This is the pattern the SDK documents for body-parser middleware and the same seam the body-size limit already uses; it depends on the public request path, not on the shape of any private field.

The params are captured by tapping the request's `push` as the body streams past, rather than by reading the body out from under the SDK.
The SDK owns parsing and validation, and its `onsessioninitialized` hook, which it awaits before it answers, is where the record is written, so the record is durable before the client can present the id anywhere.

## The lifecycle rules

- **The deadline is fixed at creation and travels with the record.** A resumed session gets the remaining lifetime, never a fresh `sessionTtlMs`, so [#107](https://github.com/amir-gorji/mcpose/issues/107)'s bound cannot be evaded by hopping between instances. A record past its deadline is unknown, whether or not the adapter has reclaimed it yet.
- **Client DELETE and TTL expiry delete the record. Server shutdown keeps it.** Sessions outliving the process is the point of the registry, and their deadlines expire them on their own. `onSessionClosed` still fires locally on shutdown, so audit manifests flush as before.
- **Identity is carried, not re-resolved.** `resolveIdentity` ran against the initialize request, which no longer exists. `validateSession` runs on every routed request on the resuming instance too, so a leaked id gains nothing from a restart.
- **`maxSessions` stays per instance.** It bounds what one process holds in memory; a resume against a full instance is a 503 and the record stays for another one. A fleet-wide cap would need a counter with its own consistency story, and nothing asked for one.
- **The registry is read only for an id the instance does not hold, and concurrent requests for one unknown id share one resume.** Locally held sessions never pay for the registry, and a burst of reconnects cannot build the same session several times.
- **Failures fail closed.** A record that cannot be written fails the initialize; the SDK turns a throwing hook into a 400 whose body echoes the error text, so the real error goes to `onError` and the hook rethrows a message that names nothing about the backing store. A lookup that fails is a 500.

## Considered Options

- **Set the SDK transport's session id and initialized flag directly.** Rejected: both live in private fields of two classes, and the `Server` behind the transport would never learn the client's capabilities. It would work until an SDK bump, and break silently then.
- **Reconstruct the initialize from `Server.getClientCapabilities()` and `getClientVersion()` at record time.** Rejected: the record would be mcpose's paraphrase of the client's request rather than the request, and the SDK's hook fires before the `Server` has processed the initialize, so the values are not yet available when the record must be written.
- **Read the request body in mcpose and pass it to the SDK as `parsedBody`.** Rejected: it moves JSON parsing and its error responses into mcpose for every session-less POST, duplicating behaviour the SDK owns, to gain nothing the passive tap does not.
- **Reset the TTL on resume.** Rejected: it makes the bounded lifecycle a per-instance courtesy rather than a bound.
- **Delete records on shutdown, since `onSessionClosed` fires.** Rejected: that is the in-memory behaviour with extra steps. The hook fires so the audit layer can seal what this process saw; the session itself is meant to continue.
- **A fleet-wide `maxSessions` through the registry.** Rejected as speculative; see the lifecycle rules.

## Consequences

- A proxy fleet behind a load balancer no longer needs sticky routing for correctness, only for efficiency: a session can be served by any instance that shares the registry and the event store. Without sticky routing, two instances can hold live copies of one session and both fire `onSessionClosed` for it.
- The audit chain does not travel. `@mcpose/audit` keeps per-session state in memory, so the shutting-down instance seals a manifest and the resuming instance opens a new chain under the same session id. Persisting the chain is a separate decision for `@mcpose/audit`.
- `Identity` must survive a JSON round-trip. `claims` that carry non-JSON values will come back changed.
- `@mcpose/store-redis` and `@mcpose/store-postgres` gain a peer dependency on `mcpose` for the `SessionRegistry` types.
