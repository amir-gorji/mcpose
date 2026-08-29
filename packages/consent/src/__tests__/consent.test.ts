import { describe, it, expect, vi } from 'vitest';
import { createConsentMiddleware } from '../index.js';
import { createProxyContext } from 'mcpose';
import type { Identity } from 'mcpose';

const identity: Identity = {
  sub: 'user-1',
  type: 'human',
  roles: ['analyst'],
  claims: {},
  resolvedAt: '2026-06-01T00:00:00.000Z',
  source: 'jwt',
};

const proxy = { name: 'test-proxy', version: '0.0.0' };

function makeCtx(withIdentity = true) {
  return createProxyContext({
    transport: 'http',
    ...(withIdentity ? { identity } : {}),
    sessionId: 'sess-1',
    proxy,
  });
}

const toolReq = {
  method: 'tools/call' as const,
  params: { name: 'read_records', arguments: {} },
};
const promptReq = {
  method: 'prompts/get' as const,
  params: { name: 'brief', arguments: {} },
};

/** Duck-types the rejection reason the way audit middleware does. */
function reasonOf(err: unknown): unknown {
  return (err as { data?: { rejectionReason?: unknown } }).data
    ?.rejectionReason;
}

describe('createConsentMiddleware — the allow path', () => {
  it('calls next when the resolver grants consent, and passes it the identity and the name', async () => {
    const resolveConsent = vi.fn(() => true);
    const { middleware } = createConsentMiddleware({ resolveConsent });
    const next = vi.fn(async () => ({ content: [] }));

    await expect(middleware(toolReq, next, makeCtx())).resolves.toEqual({
      content: [],
    });
    expect(next).toHaveBeenCalledOnce();
    expect(resolveConsent).toHaveBeenCalledWith(identity, 'read_records');
  });

  it('awaits an async resolver', async () => {
    const { middleware } = createConsentMiddleware({
      resolveConsent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return true;
      },
    });
    const next = vi.fn(async () => ({ content: [] }));

    await middleware(toolReq, next, makeCtx());
    expect(next).toHaveBeenCalledOnce();
  });

  it('gates prompts through the same resolver, on the prompt name', async () => {
    const resolveConsent = vi.fn(() => true);
    const { promptMiddleware } = createConsentMiddleware({ resolveConsent });
    const next = vi.fn(async () => ({ messages: [] }));

    await promptMiddleware(promptReq, next, makeCtx());
    expect(resolveConsent).toHaveBeenCalledWith(identity, 'brief');
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('createConsentMiddleware — fails closed', () => {
  it('rejects when no identity is resolved, without asking the resolver', async () => {
    const resolveConsent = vi.fn(() => true);
    const { middleware } = createConsentMiddleware({ resolveConsent });
    const next = vi.fn(async () => ({ content: [] }));

    await expect(
      middleware(toolReq, next, makeCtx(false)),
    ).rejects.toMatchObject({
      data: { rejectionReason: 'CONSENT_MISSING' },
    });
    expect(next).not.toHaveBeenCalled();
    expect(resolveConsent).not.toHaveBeenCalled();
  });

  it('rejects when the resolver returns false', async () => {
    const { middleware } = createConsentMiddleware({
      resolveConsent: () => false,
    });
    const next = vi.fn(async () => ({ content: [] }));

    await expect(middleware(toolReq, next, makeCtx())).rejects.toThrow(
      'user-1 has not consented to read_records',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean truthy answer rather than reading it as a grant', async () => {
    const { middleware } = createConsentMiddleware({
      // An untyped host can return anything; only `true` is a grant.
      resolveConsent: () => 'yes' as unknown as boolean,
    });
    const next = vi.fn(async () => ({ content: [] }));

    await expect(middleware(toolReq, next, makeCtx())).rejects.toMatchObject({
      data: { rejectionReason: 'CONSENT_MISSING' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when the resolver throws, reporting the failure and leaking nothing to the caller', async () => {
    const onResolverError = vi.fn();
    const { middleware } = createConsentMiddleware({
      resolveConsent: () => {
        throw new Error('consent database unreachable');
      },
      onResolverError,
    });
    const next = vi.fn(async () => ({ content: [] }));

    const err = await middleware(toolReq, next, makeCtx()).catch(
      (e: unknown) => e,
    );

    expect(reasonOf(err)).toBe('CONSENT_MISSING');
    expect(String(err)).not.toContain('consent database unreachable');
    expect(next).not.toHaveBeenCalled();
    expect(onResolverError).toHaveBeenCalledWith(expect.any(Error), {
      subject: 'user-1',
      name: 'read_records',
    });
  });

  it('still refuses with the structured error when the error hook itself throws', async () => {
    // The hook is observability. If its failure escaped, it would replace the
    // CONSENT_MISSING that audit records with a raw error, and could carry the
    // resolver detail the gate deliberately withholds out to the client.
    const { middleware } = createConsentMiddleware({
      resolveConsent: () => {
        throw new Error('consent database unreachable');
      },
      onResolverError: () => {
        throw new Error('logger exploded');
      },
    });
    const next = vi.fn(async () => ({ content: [] }));

    const err = await middleware(toolReq, next, makeCtx()).catch(
      (e: unknown) => e,
    );

    expect(reasonOf(err)).toBe('CONSENT_MISSING');
    expect(String(err)).toContain(
      'Consent for read_records could not be established',
    );
    expect(String(err)).not.toContain('logger exploded');
    expect(String(err)).not.toContain('consent database unreachable');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when the resolver rejects', async () => {
    const { middleware } = createConsentMiddleware({
      resolveConsent: () => Promise.reject(new Error('timeout')),
      onResolverError: () => {},
    });
    const next = vi.fn(async () => ({ content: [] }));

    await expect(middleware(toolReq, next, makeCtx())).rejects.toMatchObject({
      data: { rejectionReason: 'CONSENT_MISSING' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('defaults onResolverError to console.error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { middleware } = createConsentMiddleware({
      resolveConsent: () => {
        throw new Error('boom');
      },
    });

    await expect(
      middleware(toolReq, async () => ({ content: [] }), makeCtx()),
    ).rejects.toThrow();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('fails closed on the prompt surface too', async () => {
    const { promptMiddleware } = createConsentMiddleware({
      resolveConsent: () => false,
    });
    const next = vi.fn(async () => ({ messages: [] }));

    await expect(
      promptMiddleware(promptReq, next, makeCtx()),
    ).rejects.toMatchObject({
      data: { rejectionReason: 'CONSENT_MISSING' },
    });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('createConsentMiddleware — composition', () => {
  it('a refusal propagates out to a middleware composed outside it', async () => {
    // Stands in for @mcpose/audit, which is composed outside the gate so that
    // refusals land in the tamper-evident trail. This package does not depend
    // on it; what matters here is that the rejection travels outward with its
    // reason intact.
    const observed: unknown[] = [];
    const { middleware } = createConsentMiddleware({
      resolveConsent: () => false,
    });
    const ctx = makeCtx();

    const outer = async () => {
      try {
        return await middleware(toolReq, async () => ({ content: [] }), ctx);
      } catch (err) {
        observed.push(reasonOf(err));
        throw err;
      }
    };

    await expect(outer()).rejects.toThrow();
    expect(observed).toEqual(['CONSENT_MISSING']);
  });
});
