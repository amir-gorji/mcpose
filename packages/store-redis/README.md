# @mcpose/store-redis

A Redis-backed `EventStore` for mcpose's Streamable HTTP transport, so SSE reconnect replay is durable rather than capped and process-local.

mcpose's default store is in-memory and capped at 1000 events across every stream in the process.
A busy proxy therefore evicts a quiet session's replay history to make room for a loud one's, and a restart drops all of it.
This package replaces that with per-stream history in Redis, bounded by time rather than by a shared count.

> **Read this before you assume it survives a restart.**
> A durable event store is the necessary half of restart and fleet resumability, not the whole of it.
> mcpose keeps its session registry in memory, so after a restart the reconnecting client's `mcp-session-id` is unknown and the resume is rejected before the event store is ever consulted.
> See [Limits](#limits).

## Install

```bash
npm install @mcpose/store-redis redis
```

`redis` (the official node-redis client) and `@modelcontextprotocol/sdk` are peer dependencies, so the version you already run is the version this adapter uses.
This package adds no runtime dependencies of its own.

Requires Redis 6.2 or newer, for exclusive `XRANGE` bounds.

## Use

The constructor takes an already-connected client, never a connection string.
Connection lifecycle, pooling, TLS, reconnection, and shutdown stay with your application, which already knows how it wants those configured.
This adapter only reads and writes.

```ts
import { createClient } from 'redis';
import { startHttpProxy } from 'mcpose';
import { createRedisEventStore } from '@mcpose/store-redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

await startHttpProxy(
  { docs: { command: 'npx', args: ['-y', 'mcp-server-docs'] } },
  {},
  { eventStore: createRedisEventStore(redis) },
);
```

## Options

| Option | Default | What it does |
|---|---|---|
| `keyPrefix` | `'mcpose:events:'` | Namespace for every key written. Give each proxy its own prefix to share one Redis database. |
| `ttlMs` | `1_800_000` (30 minutes) | How long a stream's replay history is kept. `Infinity` keeps it forever. |

## Key layout

One [Redis stream](https://redis.io/docs/latest/develop/data-types/streams/) per MCP stream id:

```
mcpose:events:<streamId>       # XADD entries, field `d` holding the JSON-RPC message
```

`<streamId>` is whatever the MCP SDK assigns: `_GET_stream` for a session's standalone SSE stream, and a UUID per request stream.

The event id handed back to the SDK, and echoed to the client as the SSE `id:` field, is `<percent-encoded streamId>:<redis entry id>`.
Encoding the stream id into the event id is what makes `getStreamIdForEventId` a parse plus one existence check, instead of a second index that would need its own expiry.

## Retention

Retention is Redis-native: every write sets `PEXPIRE` on the stream key, so a stream is dropped `ttlMs` after its *last* event.

The default matches `startHttpProxy`'s `sessionTtlMs` default of 30 minutes, so replay history outlives the session it belongs to and is never dropped out from under a live session.
If you raise `sessionTtlMs`, raise `ttlMs` to match.

An unknown or already-expired `Last-Event-ID` replays nothing rather than the whole stream, which is what mcpose's in-memory store does.

## Limits

- **A durable store does not on its own make a resume survive a proxy restart.** mcpose holds its sessions in an in-memory `Map`, and the MCP SDK's transport validates `mcp-session-id` before it looks at `Last-Event-ID`. So a client reconnecting to a restarted proxy, or to a different instance behind a load balancer, is rejected with a `400`/`404` before this store is consulted. What you get today is durable, per-stream, uncapped history within a live session, plus the storage half of restart and fleet resumability once mcpose grows a shared session registry.
- **Retention is time-based only, never session-based.** The SDK's `EventStore` interface is given a stream id and a message, and nothing else: it never learns which MCP session a stream belongs to. So this adapter cannot drop a session's events when that session closes, and expiry is the only lever. Events therefore outlive their session by up to `ttlMs`.
- **Stream ids are not namespaced by session, because the SDK does not namespace them.** Every session's standalone SSE stream uses the literal id `_GET_stream`, so one store shared by many sessions keeps their standalone-stream history under one key. Give each proxy *process* its own `keyPrefix` if you need those separated; separating them per session is not possible through this interface.
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
