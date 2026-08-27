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
