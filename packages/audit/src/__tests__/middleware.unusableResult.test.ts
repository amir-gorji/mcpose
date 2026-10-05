import { describe, it, expect, vi } from 'vitest';
import { createAuditMiddleware } from '../middleware.js';
import { createDefaultSigningKeyProvider } from '../signingKey.js';
import { createSensitivityResolver } from '../sensitivity.js';
import { verifyAuditChain, verifyManifestSignature } from '../verify.js';
import type { AuditEvent, AuditOptions } from '../types.js';
import { createProxyContext } from 'mcpose';
import type { Identity } from 'mcpose';

/**
 * A call that neither throws nor produces a tool result is a failed call, and
 * the trail has to say so.
 *
 * `hasToolContent` narrows the pipeline's result and reads `.content` on the
 * way, so a nullish one used to throw inside the post-call section — whose
 * only handler reports and moves on. `buildEvent` never ran, so a governed
 * call that failed reached the client and never reached the trail, while the
 * manifest that counted it still verified: a valid chain under a valid
 * signature, short one event of the calls it claims to cover.
 */

const identity: Identity = {
  sub: 'user-1',
  type: 'human',
  roles: ['analyst'],
  claims: {},
  resolvedAt: '2026-06-01T00:00:00.000Z',
  source: 'jwt',
};

const signingKey = createDefaultSigningKeyProvider('test-secret');

function makeCtx(sessionId: string) {
  return createProxyContext({
    transport: 'http',
    identity,
    sessionId,
    proxy: { name: 'test-proxy', version: '0.0.0' },
  });
}

function makeReq(tool: string) {
  return {
    method: 'tools/call' as const,
    params: { name: tool, arguments: {} },
  };
}

function makeOptions(events: AuditEvent[]): AuditOptions {
  return {
    signingKey,
    sensitivityResolver: createSensitivityResolver({ search: 'low' }),
    onEvent: (e) => void events.push(e),
  };
}

describe('a pipeline that resolves without a tool result', () => {
  for (const [label, value] of [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'all good'],
    ['the number 0', 0],
  ] as const) {
    it(`records the call as an error when the pipeline resolves to ${label}`, async () => {
      const events: AuditEvent[] = [];
      const handle = createAuditMiddleware(makeOptions(events));

      await handle.middleware(
        makeReq('search'),
        async () => value as never,
        makeCtx(`sess-${label}`),
      );

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.outcome).toBe('error');
      expect(event.error).toEqual({
        name: 'InvalidToolResult',
        message: 'Tool call resolved to a value that is not a CallToolResult',
      });
      expect(event.replayManifestPosition).toBe(0);
    });
  }

  it('names the shape a prompt fetch was expected to return', async () => {
    const events: AuditEvent[] = [];
    const { promptMiddleware } = createAuditMiddleware(makeOptions(events));

    await promptMiddleware(
      { method: 'prompts/get' as const, params: { name: 'greet' } },
      async () => undefined as never,
      makeCtx('sess-prompt'),
    );

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe('prompt');
    expect(event.outcome).toBe('error');
    expect(event.error).toEqual({
      name: 'InvalidToolResult',
      message: 'Prompt fetch resolved to a value that is not a GetPromptResult',
    });
  });

  it('keeps the chain and the manifest honest across a dropped result', async () => {
    const events: AuditEvent[] = [];
    const onAuditError = vi.fn();
    const handle = createAuditMiddleware({
      ...makeOptions(events),
      onAuditError,
    });
    const ctx = makeCtx('sess-mixed');

    // First call fails the way a local tool handler with a missing `return`
    // does; the second is an ordinary success.
    await handle.middleware(
      makeReq('search'),
      async () => undefined as never,
      ctx,
    );
    await handle.middleware(
      makeReq('search'),
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      ctx,
    );

    const manifest = await handle.closeSession('sess-mixed');

    // Two governed calls, two records, in order.
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.replayManifestPosition)).toEqual([0, 1]);
    expect(events.map((e) => e.outcome)).toEqual(['error', 'success']);
    // Nothing needed the containment report any more: the unusable result is
    // in the trail, not in the operator's log.
    expect(onAuditError).not.toHaveBeenCalled();

    expect(await verifyAuditChain(events, signingKey)).toEqual({ valid: true });
    expect(manifest?.eventCount).toBe(2);
    expect(await verifyManifestSignature(manifest!, signingKey)).toBe(true);
  });
});
