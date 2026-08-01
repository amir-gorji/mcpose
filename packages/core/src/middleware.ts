/**
 * Koa-style middleware composition for MCP request/response pipelines.
 *
 * `(req, next) => Promise<Res>` — call `next(req)` to delegate downstream.
 * Middlewares wrap like an onion: outer runs before+after inner.
 *
 * `pipe([piiMW, auditMW])` execution order:
 *   1. auditMW enter  → capture startTime
 *   2. piiMW enter    → call next
 *   3. upstream call  → raw response
 *   4. piiMW exit     → redact PII
 *   5. auditMW exit   → log clean result
 */
import { createProxyContext, type ProxyContext } from './proxyContext.js';

/** Single middleware unit. May transform req before `next` or res after. */
export type Middleware<Req, Res> = (
  req: Req,
  next: (req: Req) => Promise<Res>,
  context: ProxyContext,
) => Promise<Res>;

type MiddlewarePipeline<Req, Res> = {
  (req: Req, next: (req: Req) => Promise<Res>): Promise<Res>;
  (
    req: Req,
    next: (req: Req) => Promise<Res>,
    context: ProxyContext,
  ): Promise<Res>;
};

/**
 * Composes middlewares into one, outermost-first (Koa-style).
 *
 * @example
 * const pipeline = compose([auditMW, piiMW]);
 * const result = await pipeline(req, (r) => upstream.callTool(r.params));
 */
export function compose<Req, Res>(
  middlewares: ReadonlyArray<Middleware<Req, Res>>,
): MiddlewarePipeline<Req, Res> {
  return ((req, next, context: ProxyContext = createProxyContext()) => {
    let index = -1;

    const dispatch = (i: number, currentReq: Req): Promise<Res> => {
      if (i <= index) {
        return Promise.reject(new Error('next() called multiple times'));
      }
      index = i;

      const fn: Middleware<Req, Res> =
        i < middlewares.length ? middlewares[i]! : (r) => next(r);

      return Promise.resolve(fn(currentReq, (r) => dispatch(i + 1, r), context));
    };

    return dispatch(0, req);
  }) as MiddlewarePipeline<Req, Res>;
}

/**
 * Like `compose` but in response-processing order (first = innermost).
 * `pipe([piiMW, auditMW])` ≡ `compose([auditMW, piiMW])`.
 * Used internally by mcpose core — consumers pass arrays to `ProxyOptions`.
 */
export function pipe<Req, Res>(
  middlewares: ReadonlyArray<Middleware<Req, Res>>,
): MiddlewarePipeline<Req, Res> {
  return compose([...middlewares].reverse());
}

const PASS_THROUGH_OBSERVER = Symbol.for('mcpose.passThroughObserver');

/**
 * Marks a middleware as a pass-through observer: it still runs for tools
 * listed in `ProxyOptions.passThroughTools`, which skip all other middleware.
 *
 * Use for middleware that must see every call regardless of pass-through
 * status — audit logging, telemetry — never for middleware that transforms
 * requests or responses (pass-through means "forward upstream as-is").
 *
 * Returns a new middleware; the input is not mutated.
 */
export function markPassThroughObserver<Req, Res>(
  mw: Middleware<Req, Res>,
): Middleware<Req, Res> {
  const marked: Middleware<Req, Res> = (req, next, context) =>
    mw(req, next, context);
  Object.defineProperty(marked, PASS_THROUGH_OBSERVER, {
    value: true,
    enumerable: false,
  });
  return marked;
}

/** True when the middleware was wrapped by {@link markPassThroughObserver}. */
export function isPassThroughObserver(mw: unknown): boolean {
  return typeof mw === 'function' && PASS_THROUGH_OBSERVER in mw;
}
