# @mcpose/store-redis

A Redis-backed `EventStore` and `SessionRegistry` for mcpose's Streamable HTTP transport, so SSE reconnect replay is durable rather than capped and process-local, and survives a proxy restart.

mcpose's default store is in-memory and capped at 1000 events across every stream in the process.
A busy proxy therefore evicts a quiet session's replay history to make room for a loud one's, and a restart drops all of it.
This package replaces that with per-stream history in Redis, bounded by time rather than by a shared count.

The `EventStore` is the storage half of that: it keeps the events.
The `SessionRegistry` is the other half: it keeps the session itself, so a client reconnecting to a restarted proxy, or to another instance behind a load balancer, is not rejected on its `mcp-session-id` before the events are ever consulted.
Use both, from the same Redis.

## Install

```bash
npm install @mcpose/store-redis redis
```

`redis` (the official node-redis client), `mcpose`, and `@modelcontextprotocol/sdk` are peer dependencies, so the version you already run is the version this adapter uses.
This package adds no runtime dependencies of its own.

Requires Redis 6.2 or newer, for exclusive `XRANGE` bounds.

## Use

The constructor takes an already-connected client, never a connection string.
Connection lifecycle, pooling, TLS, reconnection, and shutdown stay with your application, which already knows how it wants those configured.
This adapter only reads and writes.

```ts
import { createClient } from 'redis';
import { startHttpProxy } from 'mcpose';
import {
  createRedisEventStore,
  createRedisSessionRegistry,
} from '@mcpose/store-redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

await startHttpProxy(
  { docs: { command: 'npx', args: ['-y', 'mcp-server-docs'] } },
  { name: 'my-proxy' },
  {
    eventStore: createRedisEventStore(redis),
    sessionRegistry: createRedisSessionRegistry(redis),
  },
);
```

## Options

The options below are `createRedisEventStore`'s.
The registry's are under [Session registry](#session-registry).

| Option | Default | What it does |
|---|---|---|
| `keyPrefix` | `'mcpose:events:'` | Namespace for every key written. Give each proxy its own prefix to share one Redis database. |
| `ttlMs` | `1_800_000` (30 minutes) | How long a stream's replay history is kept. `Infinity` keeps it forever. |

## Key layout

One [Redis stream](https://redis.io/docs/latest/develop/data-types/streams/) per MCP stream id:

```
mcpose:events:<streamId>       # XADD entries, field `d` holding the JSON-RPC message
```

`<streamId>` is what mcpose hands the store: the MCP session id, a `:`, and the id the MCP SDK assigns (`_GET_stream` for the session's standalone SSE stream, a UUID per request stream).

The event id handed back to the SDK, and echoed to the client as the SSE `id:` field, is `<percent-encoded streamId>:<redis entry id>`.
Encoding the stream id into the event id is what makes `getStreamIdForEventId` a parse plus one existence check, instead of a second index that would need its own expiry.

## Retention

Retention is Redis-native: every write sets `PEXPIRE` on the stream key, so a stream is dropped `ttlMs` after its *last* event.

The default matches `startHttpProxy`'s `sessionTtlMs` default of 30 minutes, so replay history outlives the session it belongs to and is never dropped out from under a live session.
If you raise `sessionTtlMs`, raise `ttlMs` to match.

An unknown or already-expired `Last-Event-ID` replays nothing rather than the whole stream, which is what mcpose's in-memory store does.

## Session registry

`createRedisSessionRegistry` implements mcpose's `SessionRegistry` (the `sessionRegistry` option of `startHttpProxy`).
It stores one `SessionRecord` per live session: the client's `initialize` params, the resolved `Identity`, and the deadline fixed at creation.
The proxy writes the record before it answers the initialize, reads it only for a session id the instance does not hold, deletes it on client DELETE and TTL expiry, and keeps it across a shutdown.
The semantics of a resumed session (what it negotiates, how long it lives, what `validateSession` sees) are the proxy's and are documented in the [`mcpose` README](../core/README.md#surviving-a-restart).

| Option | Default | What it does |
|---|---|---|
| `keyPrefix` | `'mcpose:sessions:'` | Namespace for every record written. |

One Redis string per session at `mcpose:sessions:<sessionId>`, holding the JSON `SessionRecord`, with `PXAT` set to the deadline mcpose fixed at creation (no expiry when `sessionTtlMs` is `Infinity`).
Redis drops the key at the deadline on its own, so an expired session is unknown everywhere at the same moment.

## Limits

- **A resume needs both halves from the same backing store.** The event store alone keeps history a restarted proxy cannot reach, because the session id is rejected first; the registry alone brings a session back with no replay history. The registry also does not carry the audit chain, and a fleet without sticky routing can end up with two live copies of one session: see the [`mcpose` README](../core/README.md#surviving-a-restart).
- **Retention is time-based only, never session-based.** The SDK's `EventStore` interface is given a stream id and a message, and nothing else: it never learns which MCP session a stream belongs to. So this adapter cannot drop a session's events when that session closes, and expiry is the only lever. Events therefore outlive their session by up to `ttlMs`.
- **Stream ids are namespaced by session by mcpose, not by this store.** The SDK gives every session's standalone SSE stream the literal id `_GET_stream`; `startHttpProxy` prefixes each stream id with the session id before it reaches the store, so histories stay apart under one key prefix. Give each proxy *process* its own `keyPrefix` to keep proxies apart.
- **No cap on events per stream.** `ttlMs` bounds history by age, not by count. A stream that emits continuously for `ttlMs` keeps every event in that window. Add `XTRIM MAXLEN` out of band if your notification volume makes that a problem.
- **At-most-once durability.** A `storeEvent` that fails is surfaced to the transport, not retried here, and Redis persistence is whatever your server is configured for. Replay is a convenience for reconnecting clients, not an audit trail: for that, use [`@mcpose/audit`](../audit/README.md).

## Testing

`pnpm test` runs the `EventStore` conformance suite against an in-memory fake of the three commands this adapter calls, so no server is needed.

To run the same suite against a real Redis:

```bash
MCPOSE_REDIS_URL=redis://localhost:6379 pnpm --filter @mcpose/store-redis test
```

Without that variable, the live lane is skipped rather than failed.

## License

MIT
