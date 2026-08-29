import { describe, it, expect, vi } from 'vitest';
import { createProxyContext } from 'mcpose';
import type { Identity, ProxyContext } from 'mcpose';
import { createPolicyMiddleware } from '../index.js';
import type { PolicyOptions } from '../index.js';

function identity(roles: string[]): Identity {
  return {
    sub: 'user-1',
    type: 'human',
    roles,
    claims: {},
    resolvedAt: '2026-01-01T00:00:00.000Z',
    source: 'jwt',
  };
}

interface ToolRequest {
  method: 'tools/call';
  params: { name: string; arguments?: Record<string, unknown> };
}

function toolRequest(name: string): ToolRequest {
  return { method: 'tools/call', params: { name } };
}

/** The rejection reason a thrown McpError carries in `error.data`. */
function reasonOf(err: unknown): unknown {
  return (err as { data?: { rejectionReason?: unknown } }).data
    ?.rejectionReason;
}

/**
 * Runs the tool middleware against a stub upstream. Returns the context so a
 * test can assert on the stamped decision whether the call was allowed or
 * denied.
 */
async function run(
  options: PolicyOptions,
  name: string,
  ctxOverrides: Parameters<typeof createProxyContext>[0] = {},
): Promise<{
  ctx: ProxyContext;
  next: ReturnType<typeof vi.fn>;
  error: unknown;
}> {
  const { middleware } = createPolicyMiddleware(options);
  const ctx = createProxyContext(ctxOverrides);
  const next = vi.fn().mockResolvedValue({ content: [] });
  let error: unknown;
  try {
    await middleware(toolRequest(name), next as never, ctx);
  } catch (err) {
    error = err;
  }
  return { ctx, next, error };
}

const allowReader: PolicyOptions = {
  rules: [
    {
      id: 'reader',
      effect: 'allow',
      roles: ['reader'],
      tools: ['get_balance'],
    },
  ],
};

describe('RBAC rules', () => {
  it('allows a matching call and stamps a frozen allow decision', async () => {
    const { ctx, next, error } = await run(allowReader, 'get_balance', {
      identity: identity(['reader']),
    });

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.policy).toEqual({ decision: 'allow', ruleId: 'reader' });
    expect(Object.isFrozen(ctx.policy)).toBe(true);
  });

  it('denies by default when no rule matches, without calling next', async () => {
    const { ctx, next, error } = await run(allowReader, 'wire_funds', {
      identity: identity(['reader']),
    });

    expect(reasonOf(error)).toBe('POLICY_DENIED');
    expect(next).not.toHaveBeenCalled();
    expect(ctx.policy).toEqual({ decision: 'deny', reason: 'POLICY_DENIED' });
    expect(Object.isFrozen(ctx.policy)).toBe(true);
    // ErrorCode.InvalidRequest. The package reads the enum member off the
    // public signature of rejectionMcpError rather than depending on the SDK,
    // so the wire value is worth pinning.
    expect((error as { code: number }).code).toBe(-32600);
  });

  it('denies a caller whose roles do not match any rule', async () => {
    const { error, next } = await run(allowReader, 'get_balance', {
      identity: identity(['auditor']),
    });

    expect(reasonOf(error)).toBe('POLICY_DENIED');
    expect(next).not.toHaveBeenCalled();
  });

  it('denies with an empty rule set', async () => {
    const { error } = await run({ rules: [] }, 'get_balance', {
      identity: identity(['admin']),
    });

    expect(reasonOf(error)).toBe('POLICY_DENIED');
  });

  it('lets an explicit deny beat a matching allow, recording the deny rule id', async () => {
    const { ctx, error } = await run(
      {
        rules: [
          { id: 'all', effect: 'allow', roles: '*', tools: '*' },
          {
            id: 'no-wires',
            effect: 'deny',
            roles: '*',
            tools: ['wire_funds'],
          },
        ],
      },
      'wire_funds',
      { identity: identity(['admin']) },
    );

    expect(reasonOf(error)).toBe('POLICY_DENIED');
    expect(ctx.policy).toEqual({
      decision: 'deny',
      ruleId: 'no-wires',
      reason: 'POLICY_DENIED',
    });
  });

  it('treats a wildcard role and a wildcard tool as matching anything', async () => {
    const { next, error } = await run(
      { rules: [{ id: 'open', effect: 'allow', roles: '*', tools: '*' }] },
      'anything',
      { identity: identity([]) },
    );

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('identity requirement', () => {
  it('rejects IDENTITY_UNRESOLVED when every allow rule for the tool needs a role', async () => {
    const { ctx, next, error } = await run(allowReader, 'get_balance');

    expect(reasonOf(error)).toBe('IDENTITY_UNRESOLVED');
    expect(next).not.toHaveBeenCalled();
    expect(ctx.policy).toEqual({
      decision: 'deny',
      reason: 'IDENTITY_UNRESOLVED',
    });
  });

  it('rejects POLICY_DENIED, not IDENTITY_UNRESOLVED, when no rule covers the tool at all', async () => {
    const { error } = await run(allowReader, 'wire_funds');

    expect(reasonOf(error)).toBe('POLICY_DENIED');
  });

  it('lets a wildcard-role allow rule admit an anonymous caller', async () => {
    const { next, error } = await run(
      {
        rules: [{ id: 'public', effect: 'allow', roles: '*', tools: ['ping'] }],
      },
      'ping',
    );

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('applies a wildcard deny rule to an anonymous caller', async () => {
    const { ctx } = await run(
      {
        rules: [
          { id: 'public', effect: 'allow', roles: '*', tools: ['ping'] },
          { id: 'blocked', effect: 'deny', roles: '*', tools: ['ping'] },
        ],
      },
      'ping',
    );

    expect(ctx.policy).toMatchObject({ ruleId: 'blocked' });
  });
});

describe('sensitivity tier rules', () => {
  const tierOptions: PolicyOptions = {
    rules: [{ id: 'all', effect: 'allow', roles: '*', tools: '*' }],
    sensitivityRules: [{ roles: ['reader'], deniedTiers: ['high'] }],
    sensitivity: { get_balance: 'low', ssn_lookup: 'high' },
  };

  it('allows a low-tier tool for a role blocked only on high', async () => {
    const { next, error } = await run(tierOptions, 'get_balance', {
      identity: identity(['reader']),
    });

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks a high-tier tool with SENSITIVITY_BLOCKED and the allow rule id', async () => {
    const { ctx, next, error } = await run(tierOptions, 'ssn_lookup', {
      identity: identity(['reader']),
    });

    expect(reasonOf(error)).toBe('SENSITIVITY_BLOCKED');
    expect(next).not.toHaveBeenCalled();
    expect(ctx.policy).toEqual({
      decision: 'deny',
      ruleId: 'all',
      reason: 'SENSITIVITY_BLOCKED',
    });
  });

  it('fails closed on an unmapped name, treating it as high', async () => {
    const { error } = await run(tierOptions, 'unclassified', {
      identity: identity(['reader']),
    });

    expect(reasonOf(error)).toBe('SENSITIVITY_BLOCKED');
  });

  it('fails closed on a tier value that is not a known tier', async () => {
    const { error } = await run(
      {
        ...tierOptions,
        sensitivity: { typo: 'lowe' as never },
      },
      'typo',
      { identity: identity(['reader']) },
    );

    expect(reasonOf(error)).toBe('SENSITIVITY_BLOCKED');
  });

  it('does not let a prototype-inherited key supply a tier', async () => {
    // Tool names are attacker-controlled: `toString` must not resolve to
    // whatever `Object.prototype.toString` is.
    const { error } = await run(tierOptions, 'toString', {
      identity: identity(['reader']),
    });

    expect(reasonOf(error)).toBe('SENSITIVITY_BLOCKED');
  });

  it('leaves a caller whose roles match no tier rule unaffected', async () => {
    const { next, error } = await run(tierOptions, 'ssn_lookup', {
      identity: identity(['admin']),
    });

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not consult sensitivity at all when no tier rules are configured', async () => {
    const { next, error } = await run(
      { rules: [{ id: 'all', effect: 'allow', roles: '*', tools: '*' }] },
      'unclassified',
      { identity: identity(['reader']) },
    );

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('treats an omitted classification map as all-high', async () => {
    const { error } = await run(
      {
        rules: [{ id: 'all', effect: 'allow', roles: '*', tools: '*' }],
        sensitivityRules: [{ roles: '*', deniedTiers: ['high'] }],
      },
      'anything',
      { identity: identity(['reader']) },
    );

    expect(reasonOf(error)).toBe('SENSITIVITY_BLOCKED');
  });
});

describe('per-session budget', () => {
  const budgeted: PolicyOptions = {
    rules: [{ id: 'all', effect: 'allow', roles: '*', tools: '*' }],
    budget: { maxCallsPerSession: 2 },
  };

  async function call(
    handle: ReturnType<typeof createPolicyMiddleware>,
    sessionId: string | undefined,
  ): Promise<unknown> {
    const ctx = createProxyContext(
      sessionId === undefined ? {} : { sessionId },
    );
    try {
      await handle.middleware(
        toolRequest('ping'),
        async () => ({ content: [] }),
        ctx,
      );
    } catch (err) {
      return reasonOf(err);
    }
    return undefined;
  }

  it('rejects BUDGET_EXCEEDED once the session budget is spent', async () => {
    const handle = createPolicyMiddleware(budgeted);

    expect(await call(handle, 's1')).toBeUndefined();
    expect(await call(handle, 's1')).toBeUndefined();
    expect(await call(handle, 's1')).toBe('BUDGET_EXCEEDED');
  });

  it('counts each session separately', async () => {
    const handle = createPolicyMiddleware(budgeted);

    await call(handle, 's1');
    await call(handle, 's1');

    expect(await call(handle, 's2')).toBeUndefined();
  });

  it('never counts or blocks a call without a session id', async () => {
    const handle = createPolicyMiddleware({
      ...budgeted,
      budget: { maxCallsPerSession: 1 },
    });

    expect(await call(handle, undefined)).toBeUndefined();
    expect(await call(handle, undefined)).toBeUndefined();
    expect(await call(handle, 's1')).toBeUndefined();
  });

  it('keeps counters per middleware instance', async () => {
    const first = createPolicyMiddleware(budgeted);
    const second = createPolicyMiddleware(budgeted);

    await call(first, 's1');
    await call(first, 's1');

    expect(await call(second, 's1')).toBeUndefined();
  });

  it('does not spend budget on a call the rules already rejected', async () => {
    const handle = createPolicyMiddleware({
      rules: [
        { id: 'ping-only', effect: 'allow', roles: '*', tools: ['ping'] },
      ],
      budget: { maxCallsPerSession: 1 },
    });
    const ctx = createProxyContext({ sessionId: 's1' });
    await expect(
      handle.middleware(
        toolRequest('other') as never,
        async () => ({ content: [] }),
        ctx,
      ),
    ).rejects.toThrow();

    expect(await call(handle, 's1')).toBeUndefined();
  });

  it('stamps the deny decision when the budget is exhausted', async () => {
    const handle = createPolicyMiddleware({
      ...budgeted,
      budget: { maxCallsPerSession: 0 },
    });
    const ctx = createProxyContext({ sessionId: 's1' });

    await expect(
      handle.middleware(
        toolRequest('ping') as never,
        async () => ({ content: [] }),
        ctx,
      ),
    ).rejects.toThrow();
    expect(ctx.policy).toEqual({
      decision: 'deny',
      reason: 'BUDGET_EXCEEDED',
    });
  });
});

describe('promptMiddleware', () => {
  const handle = createPolicyMiddleware({
    rules: [
      { id: 'greeter', effect: 'allow', roles: ['user'], tools: ['greeting'] },
    ],
  });

  const promptRequest = (name: string) => ({
    method: 'prompts/get',
    params: { name },
  });

  it('gates a prompt name with the same rule set', async () => {
    const ctx = createProxyContext({ identity: identity(['user']) });
    const next = vi.fn().mockResolvedValue({ messages: [] });

    await handle.promptMiddleware(
      promptRequest('greeting') as never,
      next as never,
      ctx,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.policy).toEqual({ decision: 'allow', ruleId: 'greeter' });
  });

  it('denies a prompt no rule allows', async () => {
    const ctx = createProxyContext({ identity: identity(['user']) });

    await expect(
      handle.promptMiddleware(
        promptRequest('secret') as never,
        async () => ({ messages: [] }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { rejectionReason: 'POLICY_DENIED' } });
  });

  it('shares the session budget with the tool middleware', async () => {
    const shared = createPolicyMiddleware({
      rules: [{ id: 'all', effect: 'allow', roles: '*', tools: '*' }],
      budget: { maxCallsPerSession: 1 },
    });
    const ctx = createProxyContext({ sessionId: 's1' });

    await shared.middleware(
      toolRequest('ping'),
      async () => ({ content: [] }),
      ctx,
    );

    await expect(
      shared.promptMiddleware(
        promptRequest('greeting') as never,
        async () => ({ messages: [] }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { rejectionReason: 'BUDGET_EXCEEDED' } });
  });
});

describe('evaluation is pure and stamped before next', () => {
  it('exposes the allow decision to middleware running inside the gate', async () => {
    const { middleware } = createPolicyMiddleware(allowReader);
    const ctx = createProxyContext({ identity: identity(['reader']) });
    let seen: unknown;

    await middleware(
      toolRequest('get_balance'),
      async () => {
        seen = ctx.policy;
        return { content: [] };
      },
      ctx,
    );

    expect(seen).toEqual({ decision: 'allow', ruleId: 'reader' });
  });

  it('propagates an upstream failure untouched', async () => {
    const { middleware } = createPolicyMiddleware(allowReader);
    const ctx = createProxyContext({ identity: identity(['reader']) });
    const boom = new Error('upstream down');

    await expect(
      middleware(
        toolRequest('get_balance') as never,
        () => Promise.reject(boom),
        ctx,
      ),
    ).rejects.toBe(boom);
    expect(ctx.policy).toEqual({ decision: 'allow', ruleId: 'reader' });
  });
});
