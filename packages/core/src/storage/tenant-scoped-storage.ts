// packages/core/src/storage/tenant-scoped-storage.ts
//
// The console's tenant view over storage. A console call (or a dev tool) runs inside a view; every
// read of the store made during it (the controller's, and the metrics services' scans) only sees
// the entries tagged with the selected tenant. Outside a view the store is untouched.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Entry } from '../entry/entry.js';
import type { ConsoleTenantSelection } from '../nest/console-tenant-scope.js';
import type {
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
  TagQuery,
} from './storage-provider.js';

/** Which entries a view lets through. `tag` is pushed down to the store as the query's tag. */
export interface TenantView {
  empty: boolean;
  tag?: string;
  accept(entry: Entry): boolean;
}

interface ViewState {
  view: TenantView;
  open: boolean;
}

const views = new AsyncLocalStorage<ViewState | undefined>();

/**
 * The view of a selection. `null` (no filtering) for all organizations. A tenant sees the entries
 * tagged `<prefix>:<id>`, plus untagged ones with `nullRows: 'shared'`.
 */
export function tenantViewOf(
  selection: ConsoleTenantSelection,
  prefix: string,
  nullRows: 'tenantless' | 'shared',
): TenantView | null {
  if (selection.kind === 'all') return null;
  if (selection.kind === 'none') return { empty: true, accept: () => false };
  const tag = `${prefix}:${selection.id}`;
  if (nullRows === 'shared') {
    const own = `${prefix}:`;
    return {
      empty: false,
      accept: (entry) => entry.tags.includes(tag) || !entry.tags.some((t) => t.startsWith(own)),
    };
  }
  return { empty: false, tag, accept: (entry) => entry.tags.includes(tag) };
}

/** The view of the running console call, if any. */
export function activeTenantView(): TenantView | null {
  const state = views.getStore();
  return state?.open ? state.view : null;
}

/**
 * Opens a view: `run` executes a function inside it, `close` ends it (work the call left behind,
 * such as a timer, then reads the store unfiltered again).
 */
export function openTenantView(view: TenantView): {
  run<T>(fn: () => T): T;
  close(): void;
} {
  const state: ViewState = { view, open: true };
  return {
    run: (fn) => views.run(state, fn),
    close: () => {
      state.open = false;
    },
  };
}

/** Runs `fn` inside `view` (`null`: unfiltered), closing the view once it settles. */
export async function withTenantView<T>(view: TenantView | null, fn: () => Promise<T>): Promise<T> {
  if (view === null) return views.run(undefined, fn);
  const handle = openTenantView(view);
  try {
    return await handle.run(fn);
  } finally {
    handle.close();
  }
}

/** Runs `fn` with no view, e.g. to list the organizations a `'*'` viewer can pick. */
export function withoutTenantView<T>(fn: () => T): T {
  return views.run(undefined, fn);
}

/** How many entries a scoped tag listing reads at most. */
const TAG_SCAN_CAP = 5_000;
const TAG_SCAN_PAGE = 500;

async function scopedTags(
  storage: StorageProvider,
  view: TenantView,
  prefix: string | undefined,
  query: TagQuery | undefined,
): Promise<TagCount[]> {
  const counts = new Map<string, number>();
  const search = query?.search?.trim().toLowerCase();
  let cursor: string | undefined;
  let scanned = 0;
  do {
    const page = await storage.get({
      ...(view.tag !== undefined ? { tag: view.tag } : {}),
      omitContent: true,
      limit: TAG_SCAN_PAGE,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    scanned += page.data.length;
    for (const entry of page.data) {
      if (!view.accept(entry)) continue;
      for (const tag of new Set(entry.tags)) {
        if (prefix !== undefined && !tag.startsWith(prefix)) continue;
        if (search && !tag.toLowerCase().includes(search)) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && scanned < TAG_SCAN_CAP);
  const sorted = [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const offset = query?.offset ?? 0;
  return query?.limit !== undefined
    ? sorted.slice(offset, offset + query.limit)
    : sorted.slice(offset);
}

/**
 * Wraps a store so its reads (`get`, `find`, `batch`, `tags`) honour the active
 * {@link TenantView}. Writes, pruning and every other method pass through, and with no view
 * active the store answers exactly as unwrapped.
 */
export function asTenantScopedStorage<T extends StorageProvider>(storage: T): T {
  const reads: Record<string, (view: TenantView) => unknown> = {
    get:
      (view) =>
      async (query: EntryQuery): Promise<Page<Entry>> => {
        if (view.empty) return { data: [], nextCursor: null };
        // The tenant tag goes to the store; a different tag asked for is matched here.
        const asked = query.tag !== undefined && query.tag !== view.tag ? query.tag : undefined;
        const page = await storage.get(
          view.tag !== undefined ? { ...query, tag: view.tag } : query,
        );
        return {
          ...page,
          data: page.data.filter(
            (entry) => view.accept(entry) && (asked === undefined || entry.tags.includes(asked)),
          ),
        };
      },
    find:
      (view) =>
      async (id: string): Promise<EntryWithBatch | null> => {
        if (view.empty) return null;
        const entry = await storage.find(id);
        if (entry === null || !view.accept(entry)) return null;
        return { ...entry, batch: entry.batch.filter((member) => view.accept(member)) };
      },
    batch:
      (view) =>
      async (batchId: string): Promise<Entry[]> => {
        if (view.empty) return [];
        return (await storage.batch(batchId)).filter((entry) => view.accept(entry));
      },
    tags:
      (view) =>
      async (prefix?: string, query?: TagQuery): Promise<TagCount[]> =>
        view.empty ? [] : scopedTags(storage, view, prefix, query),
  };
  return new Proxy(storage, {
    get(target, prop) {
      const read = typeof prop === 'string' && Object.hasOwn(reads, prop) ? reads[prop] : undefined;
      const view = read !== undefined ? activeTenantView() : null;
      if (read !== undefined && view !== null) return read(view);
      return Reflect.get(target, prop, target);
    },
  });
}
