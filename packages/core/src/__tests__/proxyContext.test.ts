import { describe, expect, it } from 'vitest';
import type { Identity } from '../identity.js';
import {
  createProxyContext,
  outboundDelegationChain,
} from '../proxyContext.js';

describe('createProxyContext()', () => {
  it('defaults to stdio transport with a generated request ID', () => {
    const context = createProxyContext();

    expect(context.transport).toBe('stdio');
    expect(context.requestId).toEqual(expect.any(String));
    expect(context.requestId.length).toBeGreaterThan(0);
    expect(context.sessionId).toBeUndefined();
    expect(context.headers).toBeUndefined();
  });

  it('preserves supplied context fields', () => {
    const headers = { authorization: 'Bearer token' };
    const context = createProxyContext({
      requestId: 'req-123',
      transport: 'http',
      sessionId: 'session-1',
      headers,
    });

    expect(context).toEqual({
      requestId: 'req-123',
      transport: 'http',
      sessionId: 'session-1',
      headers,
    });
  });

  it('omits sessionId/headers/signal keys when they are not provided', () => {
    const ctx = createProxyContext({ transport: 'http' });

    expect('sessionId' in ctx).toBe(false);
    expect('headers' in ctx).toBe(false);
    expect('signal' in ctx).toBe(false);
  });

  it('omits signal key when explicitly passed as undefined', () => {
    const ctx = createProxyContext({ signal: undefined });

    expect('signal' in ctx).toBe(false);
  });

  it('preserves an AbortSignal reference', () => {
    const controller = new AbortController();
    const ctx = createProxyContext({ signal: controller.signal });

    expect(ctx.signal).toBe(controller.signal);
  });

  it('keeps the original headers reference (Readonly is shallow)', () => {
    const headers = { 'x-trace': 'abc' };
    const ctx = createProxyContext({ headers });

    expect(ctx.headers).toBe(headers);
  });

  it('regenerates a UUID when requestId is provided as an empty string', () => {
    const ctx = createProxyContext({ requestId: '' });

    expect(ctx.requestId).not.toBe('');
    expect(ctx.requestId.length).toBeGreaterThan(0);
  });

  it('generates distinct requestIds across calls', () => {
    const a = createProxyContext();
    const b = createProxyContext();

    expect(a.requestId).not.toEqual(b.requestId);
  });
});

describe('outboundDelegationChain()', () => {
  const identity = (sub: string): Identity => ({
    sub,
    type: 'agent',
    roles: [],
    claims: {},
    resolvedAt: '2026-01-01T00:00:00Z',
    source: 'custom',
  });

  it('appends identity after the existing delegatedFrom chain oldest-first', () => {
    const root = identity('root');
    const mid = identity('mid');
    const caller = identity('caller');
    const ctx = createProxyContext({
      identity: caller,
      delegatedFrom: [root, mid],
    });

    expect(outboundDelegationChain(ctx)).toEqual([root, mid, caller]);
  });

  it('returns an empty array when neither identity nor delegatedFrom is set', () => {
    expect(outboundDelegationChain(createProxyContext())).toEqual([]);
  });

  it('returns only the identity when delegatedFrom is absent', () => {
    const caller = identity('caller');
    const ctx = createProxyContext({ identity: caller });

    expect(outboundDelegationChain(ctx)).toEqual([caller]);
  });

  it('returns a fresh array and does not mutate or alias ctx.delegatedFrom', () => {
    const root = identity('root');
    const delegatedFrom = [root];
    const ctx = createProxyContext({
      identity: identity('caller'),
      delegatedFrom,
    });

    const chain = outboundDelegationChain(ctx);

    expect(chain).not.toBe(delegatedFrom);
    expect(ctx.delegatedFrom).toBe(delegatedFrom);
    expect(ctx.delegatedFrom).toEqual([root]);
    expect(outboundDelegationChain(ctx)).not.toBe(chain);
  });
});
