import type {
  SensitivityTier,
  SensitivityResolverFn,
  SensitivityOverrideFn,
} from './types.js';

const TIERS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

function validTier(value: unknown): SensitivityTier {
  // Fail CLOSED: anything that is not a known tier resolves to 'high'
  // (encrypt). Guards against typos in the map and misbehaving overrides.
  return TIERS.has(value as string) ? (value as SensitivityTier) : 'high';
}

/**
 * Builds a resolver from a static tool→tier map, with an optional dynamic
 * override that receives the map's resolution as its fourth argument.
 *
 * Unknown tools resolve to `'high'` (encrypt by default). The lookup uses
 * `Object.hasOwn`, so prototype-inherited keys (a tool named `toString` or
 * `constructor` — tool names are attacker-controlled) cannot bypass that
 * default.
 */
export function createSensitivityResolver(
  map: Record<string, SensitivityTier>,
  override?: SensitivityOverrideFn,
): SensitivityResolverFn {
  return (tool, identity, args) => {
    const mapTier = validTier(
      Object.hasOwn(map, tool) ? map[tool] : undefined,
    );
    if (override) return validTier(override(tool, identity, args, mapTier));
    return mapTier;
  };
}
