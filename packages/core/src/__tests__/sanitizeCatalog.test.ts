import { describe, it, expect } from 'vitest';
import { sanitizeToolDescriptions } from '../sanitizeCatalog.js';
import { runListToolsMiddleware } from '../testing.js';
import type {
  ListToolsRequest,
  ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';

const listReq: ListToolsRequest = { method: 'tools/list', params: {} };

interface NestedSchema {
  type: string;
  properties: Record<
    string,
    {
      type?: string;
      description?: string;
      items?: { properties: Record<string, { description?: string }> };
    }
  >;
}

function makeResult(): ListToolsResult {
  return {
    tools: [
      {
        name: 'search_issues',
        title: 'Search issues',
        description: 'Search issues. Docs: https://internal.acme-corp.dev/api',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Query, see https://acme-corp.dev/syntax',
            },
            filters: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string', description: 'acme-corp field id' },
                },
              },
            },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Link into acme-corp' },
          },
        },
      },
    ],
  };
}

async function run(
  mw = sanitizeToolDescriptions(),
  result: ListToolsResult = makeResult(),
) {
  return runListToolsMiddleware(mw, listReq, async () => result);
}

describe('sanitizeToolDescriptions()', () => {
  it('strips http(s) URLs from tool descriptions by default', async () => {
    const result = await run();
    expect(result.tools[0]?.description).toBe('Search issues. Docs: ');
  });

  it('applies string patterns to every occurrence', async () => {
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 't',
          description: 'acme-corp does acme-corp things',
          inputSchema: { type: 'object' },
        },
      ],
    };
    const result = await run(
      sanitizeToolDescriptions({ patterns: ['acme-corp'] }),
      upstream,
    );
    expect(result.tools[0]?.description).toBe(' does  things');
  });

  it('normalizes a non-global regex so every occurrence is replaced', async () => {
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 't',
          description: 'host db-1 and host db-2',
          inputSchema: { type: 'object' },
        },
      ],
    };
    const result = await run(
      sanitizeToolDescriptions({ patterns: [/db-\d/] }),
      upstream,
    );
    expect(result.tools[0]?.description).toBe('host  and host ');
  });

  it('drops a sticky flag so a sticky pattern still replaces every occurrence', async () => {
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 't',
          description: 'a db-1 b db-2',
          inputSchema: { type: 'object' },
        },
      ],
    };
    const result = await run(
      sanitizeToolDescriptions({ patterns: [/db-\d/y] }),
      upstream,
    );
    expect(result.tools[0]?.description).toBe('a  b ');
  });

  it('sanitizes description fields nested in inputSchema and outputSchema', async () => {
    const result = await run(
      sanitizeToolDescriptions({ patterns: ['acme-corp'] }),
    );
    const input = result.tools[0]?.inputSchema as unknown as NestedSchema;
    expect(input.properties.query?.description).toBe('Query, see ');
    expect(input.properties.filters?.items?.properties.field?.description).toBe(
      ' field id',
    );
    const output = result.tools[0]?.outputSchema as unknown as NestedSchema;
    expect(output.properties.url?.description).toBe('Link into ');
  });

  it('strips plain http URLs too', async () => {
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 't',
          description: 'see http://internal.host/a for details',
          inputSchema: { type: 'object' },
        },
      ],
    };
    const result = await run(sanitizeToolDescriptions(), upstream);
    expect(result.tools[0]?.description).toBe('see  for details');
  });

  it('accepts a pattern that already carries the global flag', async () => {
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 't',
          description: 'a db-1 b db-2',
          inputSchema: { type: 'object' },
        },
      ],
    };
    const result = await run(
      sanitizeToolDescriptions({ patterns: [/db-\d/g] }),
      upstream,
    );
    expect(result.tools[0]?.description).toBe('a  b ');
  });

  it('sanitizes descriptions inside schema arrays, keeping untouched siblings by reference', async () => {
    const clean = { type: 'string' };
    const untouchedEnum = ['x', 'y'];
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 't',
          inputSchema: {
            type: 'object',
            anyOf: [{ description: 'acme-corp branch' }, clean],
            allOf: [
              { description: 'acme-corp a' },
              { description: 'acme-corp b' },
            ],
            enum: untouchedEnum,
          },
        },
      ],
    };
    const result = await run(
      sanitizeToolDescriptions({ patterns: ['acme-corp'] }),
      upstream,
    );
    const schema = result.tools[0]?.inputSchema as unknown as {
      anyOf: [{ description: string }, typeof clean];
      allOf: [{ description: string }, { description: string }];
      enum: string[];
    };
    expect(Array.isArray(schema.anyOf)).toBe(true);
    expect(schema.anyOf[0].description).toBe(' branch');
    expect(schema.anyOf[1]).toBe(clean);
    expect(schema.allOf[0].description).toBe(' a');
    expect(schema.allOf[1].description).toBe(' b');
    expect(schema.enum).toBe(untouchedEnum);
  });

  it('sanitizes a tool whose only match is in outputSchema', async () => {
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 't',
          description: 'clean',
          inputSchema: { type: 'object' },
          outputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'https://internal.host/x' },
            },
          },
        },
      ],
    };
    const result = await run(sanitizeToolDescriptions(), upstream);
    const output = result.tools[0]?.outputSchema as unknown as NestedSchema;
    expect(output.properties.url?.description).toBe('');
  });

  it('ignores string values outside description keys, non-string descriptions, and null nodes', async () => {
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 't',
          description: 'acme-corp tool',
          inputSchema: {
            type: 'object',
            properties: {
              host: {
                type: 'string',
                pattern: 'acme-corp',
                default: null,
                description: { note: 'acme-corp' },
              },
            },
          } as unknown as ListToolsResult['tools'][number]['inputSchema'],
        },
      ],
    };
    const result = await run(
      sanitizeToolDescriptions({ patterns: ['acme-corp'] }),
      upstream,
    );
    expect(result.tools[0]?.description).toBe(' tool');
    const input = result.tools[0]?.inputSchema as unknown as {
      properties: {
        host: {
          pattern: string;
          default: null;
          description: { note: string };
        };
      };
    };
    expect(input.properties.host.pattern).toBe('acme-corp');
    expect(input.properties.host.default).toBeNull();
    expect(input.properties.host.description).toEqual({ note: 'acme-corp' });
  });

  it('applies no hidden default patterns beyond the URL strip', async () => {
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 't',
          description: 'Stryker was here and stays',
          inputSchema: { type: 'object' },
        },
      ],
    };
    const result = await run(sanitizeToolDescriptions(), upstream);
    expect(result).toBe(upstream);
  });

  it('does not inject absent description or outputSchema keys when rebuilding', async () => {
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 't',
          inputSchema: {
            type: 'object',
            description: 'see https://internal.host/x',
          },
        },
      ],
    };
    const result = await run(sanitizeToolDescriptions(), upstream);
    const tool = result.tools[0] as object;
    expect(
      (result.tools[0]?.inputSchema as { description?: string }).description,
    ).toBe('see ');
    expect('description' in tool).toBe(false);
    expect('outputSchema' in tool).toBe(false);
  });

  it('rebuilds only the changed tool in a mixed catalog', async () => {
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 'clean',
          description: 'nothing here',
          inputSchema: { type: 'object' },
        },
        {
          name: 'dirty',
          description: 'see https://internal.host/x',
          inputSchema: { type: 'object' },
        },
      ],
    };
    const result = await run(sanitizeToolDescriptions(), upstream);
    expect(result).not.toBe(upstream);
    expect(result.tools[0]).toBe(upstream.tools[0]);
    expect(result.tools[1]?.description).toBe('see ');
  });

  it('leaves names, titles, and schema structure intact', async () => {
    const result = await run();
    expect(result.tools[0]?.name).toBe('search_issues');
    expect(result.tools[0]?.title).toBe('Search issues');
    const input = result.tools[0]?.inputSchema as unknown as NestedSchema;
    expect(input.type).toBe('object');
    expect(Object.keys(input.properties)).toEqual(['query', 'filters']);
    expect(input.properties.query?.type).toBe('string');
  });

  it('uses the configured replacement text', async () => {
    const result = await run(
      sanitizeToolDescriptions({ replacement: '[redacted]' }),
    );
    expect(result.tools[0]?.description).toBe(
      'Search issues. Docs: [redacted]',
    );
  });

  it('does not mutate the upstream result', async () => {
    const upstream = makeResult();
    const snapshot = structuredClone(upstream);
    await run(sanitizeToolDescriptions({ patterns: ['acme-corp'] }), upstream);
    expect(upstream).toEqual(snapshot);
  });

  it('returns the original result object when nothing matches', async () => {
    const upstream: ListToolsResult = {
      tools: [
        {
          name: 'clean',
          description: 'nothing to strip here',
          inputSchema: { type: 'object' },
        },
      ],
    };
    const result = await run(sanitizeToolDescriptions(), upstream);
    expect(result).toBe(upstream);
    expect(result.tools[0]).toBe(upstream.tools[0]);
  });
});
