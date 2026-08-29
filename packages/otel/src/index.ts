/**
 * OpenTelemetry span adapter for the mcpose `onTelemetry` hook.
 * @module @mcpose/otel
 */
import { SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, Tracer } from '@opentelemetry/api';
import type { TelemetryEvent } from 'mcpose';

/** The `mcpose.*` attributes both event variants carry. */
function commonAttributes(event: TelemetryEvent): Attributes {
  return {
    'mcpose.request.id': event.requestId,
    ...(event.sessionId === undefined
      ? {}
      : { 'mcpose.session.id': event.sessionId }),
    ...(event.identity === undefined
      ? {}
      : { 'mcpose.identity.sub': event.identity.sub }),
    ...(event.proxy === undefined
      ? {}
      : {
          'mcpose.proxy.name': event.proxy.name,
          'mcpose.proxy.version': event.proxy.version,
        }),
  };
}

/** A message for a span status, and for `recordException` when nothing better exists. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds an `onTelemetry` sink that writes one completed span per
 * {@link TelemetryEvent} through the OpenTelemetry API.
 *
 * Telemetry events arrive after the work they describe has finished, so every
 * span is created with an explicit start time derived from the event and ended
 * immediately. Nothing is pushed onto the active context, so these spans are
 * roots rather than children of the caller's trace: the hook carries no span
 * context to continue. See the package README.
 *
 * The sink does not swallow exporter failures. `createProxyServer` already
 * logs a throwing `onTelemetry` sink and never fails the tool call for it, so
 * an exporter outage stays visible in the proxy's own logs instead of being
 * silently dropped here.
 *
 * @param tracer A tracer from the host's OpenTelemetry SDK, for example
 *   `trace.getTracer('mcpose')`.
 */
export function createOtelTelemetry(
  tracer: Tracer,
): (event: TelemetryEvent) => void {
  return (event) => {
    // One clock read per event: the end of the work the event describes.
    const endTime = Date.now();

    if (event.type === 'tool_call') {
      const span = tracer.startSpan(`execute_tool ${event.tool}`, {
        startTime: endTime - event.duration_ms,
        attributes: {
          ...commonAttributes(event),
          'mcpose.tool.name': event.tool,
          'mcpose.tool.outcome': event.outcome,
          'mcpose.tool.duration_ms': event.duration_ms,
          ...(event.rejectionReason === undefined
            ? {}
            : { 'mcpose.tool.rejection_reason': event.rejectionReason }),
        },
      });
      if (event.outcome !== 'success') {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: event.rejectionReason ?? event.outcome,
        });
      }
      span.end(endTime);
      return;
    }

    // A degraded backend has no duration of its own, so the span is a
    // zero-width marker at the moment the mesh reported the gap.
    const span = tracer.startSpan('mcpose.backend_degraded', {
      startTime: endTime,
      attributes: {
        ...commonAttributes(event),
        'mcpose.backend': event.backend,
        'mcpose.method': event.method,
      },
    });
    span.recordException(
      event.error instanceof Error ? event.error : describeError(event.error),
    );
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: describeError(event.error),
    });
    span.end(endTime);
  };
}
