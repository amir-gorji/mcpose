import type { SensitivityTier, SensitivityResolverFn } from './types.js';

export function createSensitivityResolver(
  map: Record<string, SensitivityTier>,
  override?: SensitivityResolverFn,
): SensitivityResolverFn {
  return (tool, identity, args) => {
    if (override) return override(tool, identity, args);
    return map[tool] ?? 'high';
  };
}
