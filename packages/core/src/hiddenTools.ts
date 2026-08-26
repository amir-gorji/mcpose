/**
 * Predicate form of `ProxyOptions.hiddenTools`, closing the dispatcher
 * bypass a name-only blocklist cannot see (a meta-tool that takes the real
 * tool name as an argument). See ADR-0006.
 */

/**
 * Decides whether a tool is hidden.
 *
 * `args` carries the phase: `undefined` during list filtering (a listed
 * tool has no arguments), and always an object at call time (empty when
 * the client sent none). That distinction lets a predicate keep a
 * dispatcher visible in `tools/list` while failing closed on a dispatcher
 * call whose target argument is missing.
 */
export type HiddenToolPredicate = (
  name: string,
  args: Readonly<Record<string, unknown>> | undefined,
) => boolean;

/** Options for {@link dispatcherAwareBlock}. */
export interface DispatcherAwareBlockOptions {
  /** Tool names to hide, whether called directly or through a dispatcher. */
  tools: ReadonlyArray<string>;
  /** Dispatcher (meta-tool) names whose target argument is checked. */
  dispatchers: ReadonlyArray<string>;
  /** Path to the target tool name inside the dispatcher's arguments. Dotted paths are supported, e.g. `'request.tool.name'`. */
  argPath: string;
}

/**
 * Resolves a dotted path through own enumerable-or-not plain-object keys.
 * Traversing a non-object, an array, or a prototype key (e.g.
 * `constructor`) resolves to `undefined` — the caller fails closed.
 */
function resolveArgPath(
  args: Readonly<Record<string, unknown>>,
  path: string,
): unknown {
  let current: unknown = args;
  for (const key of path.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !Object.hasOwn(current, key)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * A {@link HiddenToolPredicate} that blocks the listed tools both directly
 * and through the listed dispatchers.
 *
 * Fail-closed: a dispatcher call whose target argument is missing, `null`,
 * a number, an object, or an array is blocked, as is one whose `argPath`
 * cannot be resolved. The dispatcher itself stays listed in `tools/list`
 * and callable with a permitted target.
 *
 * @example
 * hiddenTools: dispatcherAwareBlock({
 *   tools: ['update_issue', 'delete_issue'],
 *   dispatchers: ['execute_sentry_tool'],
 *   argPath: 'name',
 * })
 */
export function dispatcherAwareBlock(
  options: DispatcherAwareBlockOptions,
): HiddenToolPredicate {
  const blocked = new Set(options.tools);
  const dispatchers = new Set(options.dispatchers);

  return (name, args) => {
    if (blocked.has(name)) return true;
    // args === undefined is the list phase: the dispatcher stays listed.
    if (args === undefined || !dispatchers.has(name)) return false;
    const target = resolveArgPath(args, options.argPath);
    return typeof target !== 'string' || blocked.has(target);
  };
}
