import { describe, it, expect } from 'vitest';
import { hasToolContent, mapToolResult } from '../core.js';
import type {
  CallToolResult,
  CompatibilityCallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * `hasToolContent` narrows by reading `.content`, and a value that is not a
 * tool result has none: the legacy `{ toolResult }` shape, and a pipeline that
 * resolved to nothing at all (a local tool handler with a missing `return`, or
 * a middleware that dropped the result). It is a guard, so the answer to
 * "is this a CallToolResult?" has to be `false`, not a thrown TypeError.
 *
 * Both in-repo call sites depend on that answer rather than on a throw:
 * `mapToolResult` returns the value untouched when the guard says `false`, and
 * the `tools/call` handler reads `result.isError` only behind it. A throw here
 * instead replaces whatever the pipeline produced with
 * `TypeError: Cannot read properties of undefined (reading 'content')`.
 */

/** Callers reach this through a pipeline result, which the types do not pin. */
const untyped = (value: unknown): CompatibilityCallToolResult =>
  value as CompatibilityCallToolResult;

describe('hasToolContent()', () => {
  it('is true for a CallToolResult, even an empty content array', () => {
    const result: CallToolResult = { content: [] };
    expect(hasToolContent(result)).toBe(true);
  });

  it('is false for the legacy { toolResult } shape, which has no content', () => {
    const legacy: CompatibilityCallToolResult = {
      toolResult: { raw: true },
    };
    expect(hasToolContent(legacy)).toBe(false);
  });

  it('is false for a non-object, rather than throwing', () => {
    expect(hasToolContent(untyped('a string'))).toBe(false);
    expect(hasToolContent(untyped(42))).toBe(false);
  });

  for (const [label, value] of [
    ['undefined', undefined],
    ['null', null],
  ] as const) {
    it(`is false for a ${label} result rather than throwing`, () => {
      expect(hasToolContent(untyped(value))).toBe(false);
    });

    it(`mapToolResult returns a ${label} result untouched`, () => {
      const result = untyped(value);
      expect(
        mapToolResult(result, {
          onText: () => null,
          onOther: () => null,
          onStructured: () => undefined,
        }),
      ).toBe(result);
    });
  }
});
