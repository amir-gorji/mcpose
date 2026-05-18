import { describe, it, expect } from 'vitest';
import { compose, pipe, type Middleware } from '../middleware.js';
import type { ProxyContext } from '../proxyContext.js';

type Req = { value: number };
type Res = { result: number };

const identity: Middleware<Req, Res> = (req, next) => next(req);

describe('compose()', () => {
  it('calls innermost next when middlewares array is empty', async () => {
    const pipeline = compose<Req, Res>([]);
    const result = await pipeline({ value: 1 }, async (r) => ({ result: r.value * 10 }));
    expect(result).toEqual({ result: 10 });
  });

  it('passes through a single identity middleware', async () => {
    const pipeline = compose([identity]);
    const result = await pipeline({ value: 3 }, async (r) => ({ result: r.value }));
    expect(result).toEqual({ result: 3 });
  });

  it('passes ProxyContext through the entire middleware chain unchanged', async () => {
    const context: ProxyContext = {
      requestId: 'req-1',
      transport: 'http',
      sessionId: 'sess-1',
    };
    const seen: ProxyContext[] = [];

    const outer: Middleware<Req, Res> = async (req, next, currentContext) => {
      seen.push(currentContext);
      return next(req);
    };

    const inner: Middleware<Req, Res> = async (req, next, currentContext) => {
      seen.push(currentContext);
      return next(req);
    };

    const pipeline = compose([outer, inner]);
    await pipeline({ value: 1 }, async (r) => ({ result: r.value }), context);

    expect(seen).toEqual([context, context]);
  });

  it('creates a default ProxyContext when one is omitted', async () => {
    let seenContext: ProxyContext | undefined;

    const capture: Middleware<Req, Res> = async (req, next, context) => {
      seenContext = context;
      return next(req);
    };

    const pipeline = compose([capture]);
    await pipeline({ value: 2 }, async (r) => ({ result: r.value }));

    expect(seenContext?.transport).toBe('stdio');
    expect(seenContext?.requestId).toEqual(expect.any(String));
  });

  it('executes middlewares in order — outer first, inner last', async () => {
    const order: string[] = [];

    const outer: Middleware<Req, Res> = async (req, next) => {
      order.push('outer-enter');
      const res = await next(req);
      order.push('outer-exit');
      return res;
    };

    const inner: Middleware<Req, Res> = async (req, next) => {
      order.push('inner-enter');
      const res = await next(req);
      order.push('inner-exit');
      return res;
    };

    const pipeline = compose([outer, inner]);
    await pipeline({ value: 0 }, async () => ({ result: 0 }));

    expect(order).toEqual(['outer-enter', 'inner-enter', 'inner-exit', 'outer-exit']);
  });

  it('allows outer middleware to transform the response', async () => {
    const doubler: Middleware<Req, Res> = async (req, next) => {
      const res = await next(req);
      return { result: res.result * 2 };
    };

    const pipeline = compose([doubler]);
    const result = await pipeline({ value: 5 }, async (r) => ({ result: r.value }));
    expect(result).toEqual({ result: 10 });
  });

  it('allows middleware to transform the request before passing on', async () => {
    const incrementer: Middleware<Req, Res> = (req, next) =>
      next({ value: req.value + 1 });

    const pipeline = compose([incrementer]);
    const result = await pipeline({ value: 4 }, async (r) => ({ result: r.value }));
    expect(result).toEqual({ result: 5 });
  });

  it('chains multiple transformations correctly', async () => {
    const add1: Middleware<Req, Res> = (req, next) => next({ value: req.value + 1 });
    const mul2: Middleware<Req, Res> = (req, next) => next({ value: req.value * 2 });

    // add1 outer: value = (original + 1) * 2
    const pipeline = compose([add1, mul2]);
    const result = await pipeline({ value: 3 }, async (r) => ({ result: r.value }));
    expect(result).toEqual({ result: 8 }); // (3 + 1) * 2 = 8
  });

  it('throws if next() is called more than once', async () => {
    const doubleNext: Middleware<Req, Res> = async (req, next) => {
      await next(req);
      return next(req); // second call — should throw
    };

    const pipeline = compose([doubleNext]);
    await expect(
      pipeline({ value: 0 }, async () => ({ result: 0 })),
    ).rejects.toThrow('next() called multiple times');
  });

  it('propagates errors from the inner next', async () => {
    const pipeline = compose([identity]);
    await expect(
      pipeline({ value: 0 }, async () => { throw new Error('upstream error'); }),
    ).rejects.toThrow('upstream error');
  });

  it('propagates errors thrown inside a middleware', async () => {
    const failing: Middleware<Req, Res> = async () => {
      throw new Error('middleware error');
    };

    const pipeline = compose([failing]);
    await expect(
      pipeline({ value: 0 }, async () => ({ result: 0 })),
    ).rejects.toThrow('middleware error');
  });
});

describe('pipe()', () => {
  it('pipe([A, B]) is equivalent to compose([B, A])', async () => {
    const add1: Middleware<Req, Res> = (req, next) => next({ value: req.value + 1 });
    const mul2: Middleware<Req, Res> = (req, next) => next({ value: req.value * 2 });

    // pipe([add1, mul2]) ≡ compose([mul2, add1])
    // mul2 outer: value = (original * 2) + 1 = 7
    const pipePipeline    = pipe([add1, mul2]);
    const composePipeline = compose([mul2, add1]);

    const baseNext = async (r: Req): Promise<Res> => ({ result: r.value });
    expect(await pipePipeline({ value: 3 }, baseNext)).toEqual({ result: 7 });
    expect(await composePipeline({ value: 3 }, baseNext)).toEqual({ result: 7 });
  });

  it('executes in data-flow order — first element processes the response first', async () => {
    const order: string[] = [];

    // first element in pipe() = innermost = processes response first
    const innerMW: Middleware<Req, Res> = async (req, next) => {
      order.push('inner-enter');
      const res = await next(req);
      order.push('inner-exit');
      return res;
    };

    const outerMW: Middleware<Req, Res> = async (req, next) => {
      order.push('outer-enter');
      const res = await next(req);
      order.push('outer-exit');
      return res;
    };

    // pipe([innerMW, outerMW]) — outerMW wraps innerMW
    const pipeline = pipe([innerMW, outerMW]);
    await pipeline({ value: 0 }, async () => ({ result: 0 }));

    expect(order).toEqual(['outer-enter', 'inner-enter', 'inner-exit', 'outer-exit']);
  });

  it('keeps the same ProxyContext while reversing response-processing order', async () => {
    const context: ProxyContext = { requestId: 'req-2', transport: 'stdio' };
    const seen: string[] = [];

    const innerMW: Middleware<Req, Res> = async (req, next, currentContext) => {
      seen.push(`inner:${currentContext.requestId}`);
      return next(req);
    };

    const outerMW: Middleware<Req, Res> = async (req, next, currentContext) => {
      seen.push(`outer:${currentContext.requestId}`);
      return next(req);
    };

    const pipeline = pipe([innerMW, outerMW]);
    await pipeline({ value: 1 }, async (r) => ({ result: r.value }), context);

    expect(seen).toEqual(['outer:req-2', 'inner:req-2']);
  });
});
