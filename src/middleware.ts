/**
 * Generic Koa-style middleware composition for MCP request/response pipelines.
 *
 * A middleware is a pure function:
 *   (req, next) => Promise<Res>
 *
 * Calling `next(req)` passes control to the next middleware in the chain.
 * The innermost `next` is the actual upstream call. Middlewares wrap it like
 * an onion: outer layers execute code before AND after inner layers.
 *
 * Execution order with `pipe([piiMW, auditMW])` (or equivalently `compose([auditMW, piiMW])`):
 *   1. auditMW enter  → capture startTime
 *   2. piiMW enter    → call next
 *   3. upstream call  → raw response
 *   4. piiMW exit     → redact PII
 *   5. auditMW exit   → log clean result (never logs raw PII)
 *
 * @module
 */

/**
 * A single middleware unit. Receives a request and a `next` function to
 * call the remainder of the pipeline. May transform the request before
 * calling `next` or transform the response after.
 *
 * @typeParam Req - Request type (e.g., `CallToolRequest`)
 * @typeParam Res - Response type (e.g., `CallToolResult`)
 */
export type Middleware<Req, Res> = (
  req: Req,
  next: (req: Req) => Promise<Res>,
) => Promise<Res>;

/**
 * Composes an ordered array of middlewares into a single middleware using the
 * onion (Koa-style) model. The first middleware is the outermost layer.
 *
 * The returned function accepts the initial request and an innermost `next`
 * (typically the upstream I/O call).
 *
 * @param middlewares - Ordered list of middlewares, outermost first.
 * @returns A single composed middleware.
 *
 * @example
 * ```ts
 * const pipeline = compose([auditMW, piiMW]);
 * const result = await pipeline(req, (r) => upstream.callTool(r.params));
 * ```
 */
export function compose<Req, Res>(
  middlewares: ReadonlyArray<Middleware<Req, Res>>,
): Middleware<Req, Res> {
  return (req, next) => {
    let index = -1;

    const dispatch = (i: number, currentReq: Req): Promise<Res> => {
      if (i <= index) {
        return Promise.reject(new Error('next() called multiple times'));
      }
      index = i;

      const fn: Middleware<Req, Res> =
        i < middlewares.length ? middlewares[i]! : (_r, n) => next(_r);

      return Promise.resolve(fn(currentReq, (r) => dispatch(i + 1, r)));
    };

    return dispatch(0, req);
  };
}

/**
 * Composes middlewares in response-processing order (internal helper used by mcpose core).
 *
 * The first element processes the response first — it is the innermost layer.
 * `pipe([piiMW, auditMW])` expresses "pii redacts first, then audit logs the clean result",
 * which is equivalent to `compose([auditMW, piiMW])` (outermost-first).
 *
 * This is an internal utility. Consumers pass plain arrays to `ProxyOptions` which
 * calls `pipe()` internally — there is no need to call `pipe()` directly.
 *
 * Equivalent to `compose([...middlewares].reverse())`.
 *
 * @param middlewares - Middlewares in response-processing order (first processes response first).
 * @returns A single composed middleware.
 */
export function pipe<Req, Res>(
  middlewares: ReadonlyArray<Middleware<Req, Res>>,
): Middleware<Req, Res> {
  return compose([...middlewares].reverse());
}
