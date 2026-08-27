/**
 * Egress sanitizer for the tool catalog: `tools/list` forwards upstream
 * descriptions verbatim into model context, and real upstreams leak org
 * slugs and internal hostnames there. See ADR-0010.
 */

import type { ListToolsMiddleware } from './core.js';

/** Matches http(s) URLs; always stripped regardless of `patterns`. */
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>()[\]]+/g;

/** Options for {@link sanitizeToolDescriptions}. */
export interface SanitizeToolDescriptionsOptions {
  /**
   * Extra patterns to remove. A string replaces every literal occurrence;
   * a RegExp is normalized to global, with any sticky flag dropped, so
   * every match is replaced.
   */
  patterns?: ReadonlyArray<string | RegExp>;
  /** Replacement text for every match. Default: `''` (plain removal). */
  replacement?: string;
}

/**
 * Rebuilds a schema node with every string-valued `description` property
 * sanitized, at any depth through plain objects and arrays. Returns the
 * original node when nothing changed.
 */
function sanitizeSchema(
  node: unknown,
  sanitize: (text: string) => string,
): unknown {
  if (Array.isArray(node)) {
    const mapped = node.map((item) => sanitizeSchema(item, sanitize));
    return mapped.some((item, i) => item !== node[i]) ? mapped : node;
  }
  if (node === null || typeof node !== 'object') return node;
  const entries = Object.entries(node).map(([key, value]) => [
    key,
    key === 'description' && typeof value === 'string'
      ? sanitize(value)
      : sanitizeSchema(value, sanitize),
  ]);
  return entries.some(
    ([key, value]) =>
      value !== (node as Record<string, unknown>)[key as string],
  )
    ? Object.fromEntries(entries)
    : node;
}

/**
 * A {@link ListToolsMiddleware} that sanitizes tool descriptions and every
 * `description` field nested in `inputSchema` / `outputSchema`. Names,
 * titles, and schema structure are untouched, because clients route on
 * them.
 *
 * Always strips http(s) URLs; `patterns` adds more. Place it **last** in
 * `listToolsMiddleware` so it sanitizes the output of other list
 * middleware and local tools.
 *
 * @example
 * listToolsMiddleware: [
 *   sanitizeToolDescriptions({
 *     patterns: ['acme-corp', /\bi-[0-9a-f]{8,17}\b/],
 *     replacement: '[redacted]',
 *   }),
 * ]
 */
export function sanitizeToolDescriptions(
  options: SanitizeToolDescriptionsOptions = {},
): ListToolsMiddleware {
  const replacement = options.replacement ?? '';
  const patterns: ReadonlyArray<string | RegExp> = [
    URL_PATTERN,
    // Rebuild with exactly one `g` and no `y`: String.replace with a
    // sticky regex only replaces matches anchored at index 0, so a sticky
    // pattern would silently leak later occurrences.
    ...(options.patterns ?? []).map((p) =>
      p instanceof RegExp
        ? new RegExp(p.source, p.flags.replace(/[gy]/g, '') + 'g')
        : p,
    ),
  ];
  // replaceAll treats a string pattern literally and requires the g flag
  // on a RegExp, which the normalization above guarantees.
  const sanitize = (text: string): string =>
    patterns.reduce<string>((acc, p) => acc.replaceAll(p, replacement), text);

  return async (req, next) => {
    const result = await next(req);
    const tools = result.tools.map((tool) => {
      const description =
        typeof tool.description === 'string'
          ? sanitize(tool.description)
          : tool.description;
      const inputSchema = sanitizeSchema(
        tool.inputSchema,
        sanitize,
      ) as typeof tool.inputSchema;
      const outputSchema = sanitizeSchema(
        tool.outputSchema,
        sanitize,
      ) as typeof tool.outputSchema;
      return description === tool.description &&
        inputSchema === tool.inputSchema &&
        outputSchema === tool.outputSchema
        ? tool
        : {
            ...tool,
            ...(description === undefined ? {} : { description }),
            inputSchema,
            ...(outputSchema === undefined ? {} : { outputSchema }),
          };
    });
    return tools.some((tool, i) => tool !== result.tools[i])
      ? { ...result, tools }
      : result;
  };
}
