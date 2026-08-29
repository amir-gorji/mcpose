import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import type {
  Attributes,
  SpanOptions,
  SpanStatus,
  Tracer,
} from '@opentelemetry/api';
import type { Identity, ProxyIdentity, TelemetryEvent } from 'mcpose';
import { createOtelTelemetry } from '../index.js';

/** Everything the adapter does to one span, in the order it did it. */
interface RecordedSpan {
  name: string;
  startTime: number | undefined;
  attributes: Attributes | undefined;
  status: SpanStatus | undefined;
  exceptions: unknown[];
  endTime: number | undefined;
}

/**
 * A tracer covering only the surface the adapter calls: `startSpan`, then
 * `setStatus` / `recordException` / `end` on the returned span. Casting past
 * the full `Tracer` and `Span` interfaces is the point of the fake: pulling in
 * an SDK to record four calls would make the assertions depend on the SDK's
 * own sampling and export behaviour.
 */
function fakeTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer = {
    startSpan(name: string, options?: SpanOptions) {
      const recorded: RecordedSpan = {
        name,
        startTime: options?.startTime as number | undefined,
        attributes: options?.attributes,
        status: undefined,
        exceptions: [],
        endTime: undefined,
      };
      spans.push(recorded);
      return {
        setStatus(status: SpanStatus) {
          recorded.status = status;
        },
        recordException(exception: unknown) {
          recorded.exceptions.push(exception);
        },
        end(endTime?: number) {
          recorded.endTime = endTime;
        },
      };
    },
  } as unknown as Tracer;
  return { tracer, spans };
}

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

const identity: Identity = {
  sub: 'user-42',
  type: 'human',
  roles: ['trader'],
  claims: {},
  resolvedAt: '2026-06-01T11:59:00.000Z',
  source: 'jwt',
};

const proxy: ProxyIdentity = { name: 'edge-proxy', version: '3.0.0' };

/** The single span the adapter produced for `event`. */
function spanFor(event: TelemetryEvent): RecordedSpan {
  const { tracer, spans } = fakeTracer();
  createOtelTelemetry(tracer)(event);
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createOtelTelemetry() — tool_call', () => {
  const successful: TelemetryEvent = {
    type: 'tool_call',
    requestId: 'req-1',
    sessionId: 'sess-1',
    tool: 'transfer_funds',
    duration_ms: 250,
    outcome: 'success',
    identity,
    proxy,
  };

  it('names the span after the tool and back-dates it by the reported duration', () => {
    const span = spanFor(successful);

    expect(span.name).toBe('execute_tool transfer_funds');
    expect(span.startTime).toBe(NOW - 250);
    expect(span.endTime).toBe(NOW);
  });

  it('maps identity, outcome, duration, and proxy onto mcpose attributes', () => {
    expect(spanFor(successful).attributes).toEqual({
      'mcpose.request.id': 'req-1',
      'mcpose.session.id': 'sess-1',
      'mcpose.identity.sub': 'user-42',
      'mcpose.proxy.name': 'edge-proxy',
      'mcpose.proxy.version': '3.0.0',
      'mcpose.tool.name': 'transfer_funds',
      'mcpose.tool.outcome': 'success',
      'mcpose.tool.duration_ms': 250,
    });
  });

  it('leaves a successful call unset rather than marking it OK', () => {
    expect(spanFor(successful).status).toBeUndefined();
  });

  it('omits the attributes whose fields the event does not carry', () => {
    const span = spanFor({
      type: 'tool_call',
      requestId: 'req-2',
      tool: 'search',
      duration_ms: 5,
      outcome: 'success',
    });

    expect(span.attributes).toEqual({
      'mcpose.request.id': 'req-2',
      'mcpose.tool.name': 'search',
      'mcpose.tool.outcome': 'success',
      'mcpose.tool.duration_ms': 5,
    });
    expect(span.attributes).not.toHaveProperty('mcpose.proxy.name');
    expect(span.attributes).not.toHaveProperty('mcpose.proxy.version');
    expect(span.attributes).not.toHaveProperty('mcpose.session.id');
    expect(span.attributes).not.toHaveProperty('mcpose.identity.sub');
  });

  it('records a rejected call as an error carrying the rejection reason', () => {
    const span = spanFor({
      type: 'tool_call',
      requestId: 'req-3',
      tool: 'admin_wipe',
      duration_ms: 1,
      outcome: 'rejected',
      rejectionReason: 'TOOL_HIDDEN',
      identity,
    });

    expect(span.attributes).toMatchObject({
      'mcpose.tool.outcome': 'rejected',
      'mcpose.tool.rejection_reason': 'TOOL_HIDDEN',
    });
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'TOOL_HIDDEN',
    });
  });

  it('records a failed call as an error without inventing a rejection reason', () => {
    const span = spanFor({
      type: 'tool_call',
      requestId: 'req-4',
      tool: 'search',
      duration_ms: 12,
      outcome: 'error',
    });

    expect(span.attributes).not.toHaveProperty('mcpose.tool.rejection_reason');
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'error',
    });
  });
});

describe('createOtelTelemetry() — backend_degraded', () => {
  const degraded = (error: unknown): TelemetryEvent => ({
    type: 'backend_degraded',
    requestId: 'req-5',
    sessionId: 'sess-5',
    backend: 'ledger',
    method: 'tools/list',
    error,
    identity,
    proxy,
  });

  it('emits a zero-width error span naming the backend and the method', () => {
    const cause = new Error('upstream refused the connection');
    const span = spanFor(degraded(cause));

    expect(span.name).toBe('mcpose.backend_degraded');
    expect(span.startTime).toBe(NOW);
    expect(span.endTime).toBe(NOW);
    expect(span.attributes).toEqual({
      'mcpose.request.id': 'req-5',
      'mcpose.session.id': 'sess-5',
      'mcpose.identity.sub': 'user-42',
      'mcpose.proxy.name': 'edge-proxy',
      'mcpose.proxy.version': '3.0.0',
      'mcpose.backend': 'ledger',
      'mcpose.method': 'tools/list',
    });
    expect(span.exceptions).toEqual([cause]);
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'upstream refused the connection',
    });
  });

  it('stringifies a thrown non-Error, because the sink takes whatever the backend threw', () => {
    const span = spanFor(degraded('socket hang up'));

    expect(span.exceptions).toEqual(['socket hang up']);
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'socket hang up',
    });
  });

  it('omits proxy and session attributes when the event does not carry them', () => {
    const span = spanFor({
      type: 'backend_degraded',
      requestId: 'req-6',
      backend: 'ledger',
      method: 'prompts/list',
      error: new Error('timed out'),
    });

    expect(span.attributes).toEqual({
      'mcpose.request.id': 'req-6',
      'mcpose.backend': 'ledger',
      'mcpose.method': 'prompts/list',
    });
  });
});
