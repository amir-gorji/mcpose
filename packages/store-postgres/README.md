# @mcpose/store-postgres

A Postgres-backed `EventStore` for mcpose's Streamable HTTP transport, so SSE reconnect replay is durable rather than capped and process-local.

mcpose's default store is in-memory and capped at 1000 events across every stream in the process.
A busy proxy therefore evicts a quiet session's replay history to make room for a loud one's, and a restart drops all of it.
This package replaces that with per-stream history in Postgres, bounded by time rather than by a shared count.

> **Read this before you assume it survives a restart.**
> A durable event store is the necessary half of restart and fleet resumability, not the whole of it.
> mcpose keeps its session registry in memory, so after a restart the reconnecting client's `mcp-session-id` is unknown and the resume is rejected before the event store is ever consulted.
> See [Limits](#limits).

## Install

```bash
npm install @mcpose/store-postgres pg
```

`pg` and `@modelcontextprotocol/sdk` are peer dependencies, so the version you already run is the version this adapter uses.
This package adds no runtime dependencies of its own.

## Use

The constructor takes an already-connected client or pool, never a connection string.
Connection lifecycle, pooling, TLS, and shutdown stay with your application, which already knows how it wants those configured.
This adapter only reads and writes.

```ts
import { Pool } from 'pg';
import { startHttpProxy } from 'mcpose';
import { createPostgresEventStore } from '@mcpose/store-postgres';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const eventStore = createPostgresEventStore(pool);

await eventStore.init();
setInterval(() => void eventStore.pruneExpired(), 60_000).unref();

await startHttpProxy(
  { docs: { command: 'npx', args: ['-y', 'mcp-server-docs'] } },
  {},
  { eventStore },
);
```

## Options

| Option | Default | What it does |
|---|---|---|
| `table` | `'mcpose_events'` | Table holding the events, optionally schema-qualified. Validated as a plain SQL identifier and rejected otherwise, because it is interpolated into SQL. |
| `ttlMs` | `1_800_000` (30 minutes) | How long an event stays replayable. `Infinity` keeps history forever. |
| `pruneEveryWrites` | `1000` | Run `pruneExpired()` in the background once every this many writes. `0` disables it. |
| `onError` | `console.error` | Called when a background prune fails. |

## Schema

`init()` runs exactly this, and never runs implicitly on a write.
Run it once at startup, or apply the SQL yourself as a migration and skip the call:

```sql
CREATE TABLE IF NOT EXISTS mcpose_events (
  event_id   bigserial PRIMARY KEY,
  stream_id  text NOT NULL,
  message    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcpose_events_stream_idx ON mcpose_events (stream_id, event_id);
CREATE INDEX IF NOT EXISTS mcpose_events_created_at_idx ON mcpose_events (created_at);
```

`event_id` is the id handed back to the SDK and echoed to the client as the SSE `id:` field.
A `bigserial` gives replay a total order that keeps increasing across restarts and across every instance sharing the database, which a per-process counter would not.

## Retention

Postgres has no native TTL, so retention is two halves:

- **Enforced on read.** An event older than `ttlMs` is never replayed and never resolves a `Last-Event-ID`, whether or not it has been deleted yet. Expiry is therefore correct no matter how often you prune.
- **Reclaimed by pruning.** `pruneExpired()` deletes every row older than `ttlMs` and returns the count. Schedule it, or partition by `created_at` and drop partitions. As a backstop, the adapter also runs it in the background once every `pruneEveryWrites` writes, so a host that forgets to schedule anything still does not grow without bound.

The default `ttlMs` matches `startHttpProxy`'s `sessionTtlMs` default of 30 minutes, so replay history outlives the session it belongs to and is never dropped out from under a live session.
If you raise `sessionTtlMs`, raise `ttlMs` to match.

An unknown or already-expired `Last-Event-ID` replays nothing rather than the whole stream, which is what mcpose's in-memory store does.

## Limits

- **A durable store does not on its own make a resume survive a proxy restart.** mcpose holds its sessions in an in-memory `Map`, and the MCP SDK's transport validates `mcp-session-id` before it looks at `Last-Event-ID`. So a client reconnecting to a restarted proxy, or to a different instance behind a load balancer, is rejected with a `400`/`404` before this store is consulted. What you get today is durable, per-stream, uncapped history within a live session, plus the storage half of restart and fleet resumability once mcpose grows a shared session registry.
- **Retention is time-based only, never session-based.** The SDK's `EventStore` interface is given a stream id and a message, and nothing else: it never learns which MCP session a stream belongs to. So this adapter cannot drop a session's events when that session closes, and expiry is the only lever. Events therefore outlive their session by up to `ttlMs`.
- **Stream ids are not namespaced by session, because the SDK does not namespace them.** Every session's standalone SSE stream uses the literal id `_GET_stream`, so one store shared by many sessions keeps their standalone-stream history under one `stream_id`. Give each proxy *process* its own `table` if you need those separated; separating them per session is not possible through this interface.
- **A row per event, on the hot path.** Every SSE notification is an `INSERT`. Postgres will not be the bottleneck at typical MCP notification volume, but it is a synchronous write on the send path, and Redis is the better fit if your volume is high. Point the store at a replica-backed pool, not your primary OLTP connection budget.
- **No cap on events per stream.** `ttlMs` bounds history by age, not by count.
- **At-most-once durability.** A `storeEvent` that fails is surfaced to the transport, not retried here. Replay is a convenience for reconnecting clients, not an audit trail: for that, use [`@mcpose/audit`](../audit/README.md).

## Testing

`pnpm test` runs the `EventStore` conformance suite against [pg-mem](https://github.com/oguimbal/pg-mem), which executes the real SQL in-process, so no server is needed and the schema above is genuinely exercised.

To run the same suite against a real Postgres:

```bash
MCPOSE_POSTGRES_URL=postgres://user:pass@localhost:5432/mcpose pnpm --filter @mcpose/store-postgres test
```

Without that variable, the live lane is skipped rather than failed.

## License

MIT
