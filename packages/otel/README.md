# @mcpose/otel

[![npm](https://img.shields.io/npm/v/@mcpose/otel)](https://www.npmjs.com/package/@mcpose/otel)
[![license](https://img.shields.io/npm/l/@mcpose/otel)](https://github.com/amir-gorji/mcpose/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@mcpose/otel)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml/badge.svg)](https://github.com/amir-gorji/mcpose/actions/workflows/ci.yml)

**An OpenTelemetry span adapter for [`mcpose`](https://www.npmjs.com/package/mcpose)'s `onTelemetry` hook.**

One function, `createOtelTelemetry(tracer)`, returns a sink you assign to `ProxyOptions.onTelemetry`.
Every `TelemetryEvent` the proxy emits becomes one completed span on the tracer you pass in.

It brings no SDK of its own.
`@opentelemetry/api` is a peer dependency, so the host application owns the SDK, the exporter, the sampler, and their versions.

## Table of Contents

- [What it does and does not do](#what-it-does-and-does-not-do)
- [When to reach for it](#when-to-reach-for-it)
- [Install](#install)
- [Quick start](#quick-start)
- [API](#api)
- [Span mapping](#span-mapping)
- [Documentation](#documentation)
- [License](#license)

## What it does and does not do

Read this before wiring it into a trace you rely on.

**The spans are post-hoc.**
`onTelemetry` fires after the tool call has already returned, and the event carries a `duration_ms` rather than a live span.
So the adapter creates each span with an explicit start time of `Date.now() - duration_ms` and ends it immediately.
The timings are as accurate as the event is; the span simply did not exist while the work was running.

**There is no context propagation.**
The hook hands over no span context, so these spans are roots, not children of whatever the caller was tracing, and nothing the proxy does downstream is nested under them.
Correlate on `mcpose.request.id` and `mcpose.session.id` instead.
Real parent and child spans need instrumentation inside the pipeline, which is middleware work rather than sink work, and is not in this package.

**It does not swallow exporter failures.**
`createProxyServer` already logs a throwing `onTelemetry` sink and never fails the tool call for it, so an exporter outage stays visible in the proxy's own logs rather than disappearing here.
Adding a second guard would only hide it.

## When to reach for it

You already run an OpenTelemetry SDK and want mcpose tool calls and mesh degradations in the same trace backend as the rest of your services, without writing the mapping by hand.

If you want the events somewhere else entirely, `onTelemetry` is a plain function: write to it directly and skip this package.

## Install

```bash
npm install @mcpose/otel
```

Requires Node.js 20+.
`mcpose` and `@opentelemetry/api` are peer dependencies.

## Quick start

```ts
import { trace } from '@opentelemetry/api';
import { createOtelTelemetry } from '@mcpose/otel';
import { startProxy } from 'mcpose';

await startProxy(backends, {
  name: 'my-proxy',
  onTelemetry: createOtelTelemetry(trace.getTracer('mcpose')),
});
```

The tracer comes from your own SDK setup, so register the provider and exporter before the proxy starts, exactly as you would for any other instrumentation.

## API

| Export | Signature | Returns |
|---|---|---|
| `createOtelTelemetry` | `(tracer: Tracer) => (event: TelemetryEvent) => void` | A sink assignable to `ProxyOptions.onTelemetry`, writing one completed span per event. |

## Span mapping

A `'tool_call'` event becomes a span named `execute_tool <tool>`, following the OpenTelemetry naming style of a low-cardinality operation plus its target.
A `'backend_degraded'` event becomes a zero-width span named `mcpose.backend_degraded` at the moment the mesh reported the gap, because a dropped backend has no duration of its own.

| Attribute | Source | Present when |
|---|---|---|
| `mcpose.request.id` | `event.requestId` | Always. |
| `mcpose.session.id` | `event.sessionId` | The transport is stateful HTTP. |
| `mcpose.identity.sub` | `event.identity.sub` | `resolveIdentity` is configured. |
| `mcpose.proxy.name`, `mcpose.proxy.version` | `event.proxy` | The proxy stamps its identity (ADR-0012). |
| `mcpose.tool.name`, `mcpose.tool.outcome`, `mcpose.tool.duration_ms` | the `'tool_call'` event | Always, on a `'tool_call'` span. |
| `mcpose.tool.rejection_reason` | `event.rejectionReason` | The outcome is `'rejected'`. |
| `mcpose.backend`, `mcpose.method` | the `'backend_degraded'` event | Always, on a `'backend_degraded'` span. |

Only the `sub` claim of an identity is attributed.
Roles, display names, and the rest of the claims are caller data that does not belong in a span exported to a third-party backend; the audit chain in [`@mcpose/audit`](https://www.npmjs.com/package/@mcpose/audit) is where the full record lives.

Status is set to `ERROR` on a `'backend_degraded'` span, with the thrown error also recorded via `recordException`, and on a `'tool_call'` span whose outcome is `'error'` or `'rejected'`, with the rejection reason as the message.
A successful call is left `UNSET`, which is the OpenTelemetry default and what a backend expects for an operation that simply worked.

## Documentation

- [Project README](https://github.com/amir-gorji/mcpose#readme): concepts, comparison, and guides
- [`mcpose`](https://www.npmjs.com/package/mcpose): the proxy core that emits these events
- [`CONTEXT.md`](https://github.com/amir-gorji/mcpose/blob/main/CONTEXT.md): the canonical domain glossary

## License

MIT © Amir Gorji
