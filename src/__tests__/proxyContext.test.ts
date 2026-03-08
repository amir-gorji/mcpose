import { describe, expect, it } from 'vitest';
import { createProxyContext } from '../proxyContext.js';

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
});
