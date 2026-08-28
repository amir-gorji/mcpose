/**
 * Multi-backend (mesh) composition: backend-key validation, namespacing,
 * routing, and failure-isolated listing. See ADR-0013.
 */
import type { BackendClient } from './backendClient.js';

/**
 * Separates a backend key from the upstream name in mesh mode:
 * `<backendKey>__<name>`. A key may not contain it, so the first occurrence
 * always splits the two, even when the upstream name contains one itself.
 */
const BACKEND_NAMESPACE_SEPARATOR = '__';

/**
 * Pages drained from one backend before the proxy gives up on it. A backend
 * that never advances its cursor would otherwise hang the whole list.
 */
const MAX_PAGES_PER_BACKEND = 100;

/** One named upstream of a mesh. */
export interface MeshEntry {
  readonly key: string;
  readonly client: BackendClient;
}

/**
 * Either a single upstream (1:1 proxy, no namespacing) or a record of named
 * backends keyed by backend key (mesh mode). See ADR-0013.
 */
export type Backends = BackendClient | Readonly<Record<string, BackendClient>>;

const isBackendClient = (backends: Backends): backends is BackendClient =>
  typeof (backends as BackendClient).getServerCapabilities === 'function';

/**
 * Normalizes the `backends` argument to an ordered entry list. The 1:1 form
 * yields a single entry with an empty key and `mesh: false`.
 *
 * @throws On an empty record, an empty backend key, or a key containing the
 * namespace separator — each would make an exposed name ambiguous, and
 * guessing which upstream a caller meant is the failure mesh routing exists
 * to prevent.
 */
export function normalizeBackends(backends: Backends): {
  mesh: boolean;
  entries: ReadonlyArray<MeshEntry>;
} {
  if (isBackendClient(backends)) {
    return { mesh: false, entries: [{ key: '', client: backends }] };
  }

  const entries = Object.entries(backends).map(([key, client]) => ({
    key,
    client,
  }));

  if (entries.length === 0) {
    throw new Error(
      'mcpose: backends record is empty — pass at least one named backend, or a single BackendClient for a 1:1 proxy.',
    );
  }
  for (const { key } of entries) {
    if (key === '') {
      throw new Error('mcpose: backend key must not be empty');
    }
    if (key.includes(BACKEND_NAMESPACE_SEPARATOR)) {
      throw new Error(
        `mcpose: backend key "${key}" must not contain "${BACKEND_NAMESPACE_SEPARATOR}" — it is the namespace separator`,
      );
    }
  }

  return { mesh: true, entries };
}

/** The name a mesh exposes for `name` on the backend keyed `key`. */
function namespacedName(key: string, name: string): string {
  return `${key}${BACKEND_NAMESPACE_SEPARATOR}${name}`;
}

/**
 * Resolves an exposed name to its backend and upstream name.
 *
 * Returns `undefined` for an un-namespaced name, an unknown key, or an empty
 * upstream name. The caller turns that into a loud `BACKEND_UNROUTABLE`
 * rejection: there is deliberately no "resolve it if only one backend has
 * that name" fallback, because it silently re-routes once a backend is added.
 */
export function routeNamespaced(
  name: string,
  byKey: ReadonlyMap<string, BackendClient>,
): { client: BackendClient; name: string } | undefined {
  const at = name.indexOf(BACKEND_NAMESPACE_SEPARATOR);
  if (at <= 0) return undefined;
  const client = byKey.get(name.slice(0, at));
  const upstreamName = name.slice(at + BACKEND_NAMESPACE_SEPARATOR.length);
  if (client === undefined || upstreamName === '') return undefined;
  return { client, name: upstreamName };
}

/** One page of a paginated list surface. */
export interface MeshPage<Item> {
  items: ReadonlyArray<Item>;
  nextCursor: string | undefined;
}

/**
 * Lists one paginated surface across every backend concurrently, namespacing
 * each entry's name and isolating failures: a backend that throws (or never
 * finishes paginating) contributes nothing and is reported through
 * `onDegraded`, while the live backends' entries are still returned.
 *
 * Entries keep backend declaration order. A backend that fails part-way
 * through pagination contributes nothing at all rather than a truncated
 * list, so the response never looks complete when it is not.
 */
export async function listAcrossMesh<Item extends { name: string }>(
  entries: ReadonlyArray<MeshEntry>,
  listPage: (
    client: BackendClient,
    cursor: string | undefined,
  ) => Promise<MeshPage<Item>>,
  onDegraded: (key: string, error: unknown) => void,
): Promise<Item[]> {
  const settled = await Promise.allSettled(
    entries.map(async ({ key, client }) => {
      const collected: Item[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES_PER_BACKEND; page += 1) {
        const { items, nextCursor } = await listPage(client, cursor);
        for (const item of items) {
          collected.push({ ...item, name: namespacedName(key, item.name) });
        }
        if (nextCursor === undefined) return collected;
        cursor = nextCursor;
      }
      throw new Error(
        `mcpose: backend "${key}" did not finish paginating within ${MAX_PAGES_PER_BACKEND} pages`,
      );
    }),
  );

  return settled.flatMap((outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    onDegraded(entries[index]!.key, outcome.reason);
    return [];
  });
}
