import { describe, it, expect, vi } from 'vitest';
import { mapToolResult } from '../core.js';
import type { ToolResultHandlers } from '../core.js';
import type {
  CallToolResult,
  CompatibilityCallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

/** Handlers that pass every channel through unchanged. */
const identity: ToolResultHandlers = {
  onText: (block) => block,
  onOther: (block) => block,
  onStructured: (structured) => structured,
};

describe('mapToolResult()', () => {
  it('maps text blocks through onText', () => {
    const result: CallToolResult = {
      content: [{ type: 'text', text: 'ssn 123456789' }],
    };

    const mapped = mapToolResult(result, {
      ...identity,
      onText: (block) => ({ ...block, text: '[REDACTED]' }),
    });

    expect(mapped.content).toEqual([{ type: 'text', text: '[REDACTED]' }]);
  });

  it('routes non-text blocks through onOther, and null drops the block', () => {
    const result: CallToolResult = {
      content: [
        { type: 'text', text: 'keep' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      ],
    };
    const onOther = vi.fn().mockReturnValue(null);

    const mapped = mapToolResult(result, { ...identity, onOther });

    expect(onOther).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image' }),
    );
    expect(mapped.content).toEqual([{ type: 'text', text: 'keep' }]);
  });

  it('null from onText drops the block too', () => {
    const result: CallToolResult = {
      content: [{ type: 'text', text: 'drop me' }],
    };

    const mapped = mapToolResult(result, { ...identity, onText: () => null });
    expect(mapped.content).toEqual([]);
  });

  it('calls onStructured only when structuredContent is present', () => {
    const onStructured = vi.fn().mockReturnValue({ ok: true });

    mapToolResult({ content: [] }, { ...identity, onStructured });
    expect(onStructured).not.toHaveBeenCalled();

    const mapped = mapToolResult(
      { content: [], structuredContent: { secret: 'x' } },
      { ...identity, onStructured },
    );
    expect(onStructured).toHaveBeenCalledWith({ secret: 'x' });
    expect(mapped.structuredContent).toEqual({ ok: true });
  });

  it('undefined from onStructured removes the field', () => {
    const mapped = mapToolResult(
      { content: [], structuredContent: { secret: 'x' } },
      { ...identity, onStructured: () => undefined },
    );
    expect(mapped).not.toHaveProperty('structuredContent');
  });

  it('returns the legacy { toolResult } shape untouched', () => {
    const legacy: CompatibilityCallToolResult = { toolResult: { raw: true } };
    const onText = vi.fn();

    expect(mapToolResult(legacy, { ...identity, onText })).toBe(legacy);
    expect(onText).not.toHaveBeenCalled();
  });

  it('preserves isError, result _meta, and unknown extra keys', () => {
    const result: CallToolResult = {
      content: [],
      isError: true,
      _meta: { forwarded: 'deliberately' },
      vendorKey: 'kept',
    };

    const mapped = mapToolResult(result, identity);
    expect(mapped).toMatchObject({
      isError: true,
      _meta: { forwarded: 'deliberately' },
      vendorKey: 'kept',
    });
  });
});
