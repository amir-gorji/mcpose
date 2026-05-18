import { describe, it, expect } from 'vitest';
import { compose, pipe, type Middleware } from '../middleware.js';
import { createProxyContext, type ProxyContext } from '../proxyContext.js';

type Req = { value: number };
type Res = { result: number };

const passthroughNext = async (r: Req): Promise<Res> => ({ result: r.value });

describe('compose() — edge cases', () => {
  it('rejects (not throws synchronously) when next() is called twice in the same middleware', async () => {
    let secondCallReturn: unknown;
    const dbl: Middleware<Req, Res> = async (req, next) => {
      const first = next(req);
      secondCallReturn = next(req);
      await first;
      return { result: 0 };
    };

    const pipeline = compose([dbl]);
    const promise = pipeline({ value: 1 }, passthroughNext);

    expect(secondCallReturn).toBeInstanceOf(Promise);
    await expect(secondCallReturn as Promise<Res>).rejects.toThrow(
      'next() called multiple times',
    );
    await expect(promise).resolves.toBeDefined();
  });

  it('rejects on a second next() call even after the first has settled', async () => {
    let captured: Promise<Res> | undefined;
    const mw: Middleware<Req, Res> = async (req, next) => {
      const first = await next(req);
      captured = next(req);
      return first;
    };

    const pipeline = compose([mw]);
    await pipeline({ value: 1 }, passthroughNext);

    await expect(captured).rejects.toThrow('next() called multiple times');
  });

  it('does not mutate a frozen middleware array', async () => {
    const mw: Middleware<Req, Res> = (req, next) => next({ value: req.value + 1 });
    const arr = Object.freeze([mw]) as ReadonlyArray<Middleware<Req, Res>>;

    const pipeline = compose(arr);
    const result = await pipeline({ value: 2 }, passthroughNext);

    expect(result).toEqual({ result: 3 });
    expect(arr).toHaveLength(1);
  });

  it('generates a fresh requestId for each invocation when no context is provided', async () => {
    const seen: string[] = [];
    const capture: Middleware<Req, Res> = async (req, next, context) => {
      seen.push(context.requestId);
      return next(req);
    };

    const pipeline = compose([capture]);
    await pipeline({ value: 1 }, passthroughNext);
    await pipeline({ value: 1 }, passthroughNext);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toEqual(seen[1]);
  });

  it('propagates errors thrown from inner-most next through wrappers', async () => {
    const wrap: Middleware<Req, Res> = async (req, next) => next(req);
    const pipeline = compose([wrap, wrap, wrap]);

    await expect(
      pipeline({ value: 0 }, async () => {
        throw new Error('inner boom');
      }),
    ).rejects.toThrow('inner boom');
  });

  it('passes the same context reference to every middleware', async () => {
    const refs: ProxyContext[] = [];
    const capture: Middleware<Req, Res> = async (req, next, context) => {
      refs.push(context);
      return next(req);
    };
    const ctx = createProxyContext({ requestId: 'fixed-id' });

    await compose([capture, capture, capture])({ value: 1 }, passthroughNext, ctx);

    expect(refs).toHaveLength(3);
    expect(refs[0]).toBe(ctx);
    expect(refs[1]).toBe(ctx);
    expect(refs[2]).toBe(ctx);
  });
});

describe('pipe() — edge cases', () => {
  it('does not mutate the input array (reverse on a copy)', async () => {
    const a: Middleware<Req, Res> = (req, next) => next({ value: req.value + 1 });
    const b: Middleware<Req, Res> = (req, next) => next({ value: req.value * 2 });
    const arr = [a, b];
    const snapshot = [...arr];

    await pipe(arr)({ value: 1 }, passthroughNext);

    expect(arr).toEqual(snapshot);
  });

  it('accepts a frozen input array', async () => {
    const a: Middleware<Req, Res> = (req, next) => next({ value: req.value + 1 });
    const arr = Object.freeze([a]) as ReadonlyArray<Middleware<Req, Res>>;

    const result = await pipe(arr)({ value: 1 }, passthroughNext);

    expect(result).toEqual({ result: 2 });
  });
});
