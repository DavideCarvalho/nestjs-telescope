// packages/core/src/nest/console-app-scope.ts
//
// The console's app scope: which apps' entries a viewer sees. A control plane tags each entry it
// receives with `app:<partition>`; a standalone app has no such tag, so its console has no App
// control and every read is unchanged.
import type { Entry } from '../entry/entry.js';
import type { TenantView } from '../storage/tenant-scoped-storage.js';
import { APP_TAG_PREFIX } from '../topology/wire.js';

/** What `authorize` may grant: `'*'` every app (the default), or these app ids. */
export type ConsoleApps = '*' | string[];

/** The apps one console call shows, after `?app=` met the grant. */
export type ConsoleAppSelection =
  | { kind: 'all' }
  | { kind: 'apps'; ids: string[] }
  | { kind: 'none'; forged?: string };

/** Reads `apps` from an `authorize` result: `'*'`, a list of non-empty ids, or absent. */
export function consoleAppsOf(result: unknown): ConsoleApps | undefined {
  if (typeof result !== 'object' || result === null || !('apps' in result)) return undefined;
  const apps = (result as { apps?: unknown }).apps;
  if (apps === '*') return '*';
  if (!Array.isArray(apps)) return undefined;
  if (apps.includes('*')) return '*';
  return [...new Set(apps.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/**
 * Meets the `?app=` of a call with the grant (omitted: every app). No `?app=` (or `'*'`): every
 * granted app. An app outside the grant is `none` with `forged` set: the call answers empty.
 */
export function selectConsoleApp(
  apps: ConsoleApps | undefined,
  requested: unknown,
): ConsoleAppSelection {
  const granted = apps ?? '*';
  const id =
    typeof requested === 'string' && requested !== '' && requested !== '*' ? requested : undefined;
  if (granted === '*') return id === undefined ? { kind: 'all' } : { kind: 'apps', ids: [id] };
  if (id !== undefined) {
    return granted.includes(id) ? { kind: 'apps', ids: [id] } : { kind: 'none', forged: id };
  }
  return granted.length === 0 ? { kind: 'none' } : { kind: 'apps', ids: granted };
}

/** The app tag of an entry (`app:<id>`), or `undefined`. */
export function appOfEntry(entry: Pick<Entry, 'tags'>): string | undefined {
  const prefix = `${APP_TAG_PREFIX}:`;
  const tag = entry.tags.find((t) => t.startsWith(prefix));
  return tag === undefined ? undefined : tag.slice(prefix.length);
}

/**
 * The view of an app selection: `null` (no filtering) for every app. One app pushes its tag down
 * to the store; several are matched here.
 */
export function appViewOf(selection: ConsoleAppSelection): TenantView | null {
  if (selection.kind === 'all') return null;
  if (selection.kind === 'none') return { empty: true, key: '', accept: () => false };
  const tags = selection.ids.map((id) => `${APP_TAG_PREFIX}:${id}`);
  const key = tags.join(',');
  if (tags.length === 1) {
    const tag = tags[0] as string;
    return { empty: false, key, tag, accept: (entry) => entry.tags.includes(tag) };
  }
  const set = new Set(tags);
  return { empty: false, key, accept: (entry) => entry.tags.some((t) => set.has(t)) };
}

/** Whether a grant limits the viewer to some apps. */
export function restrictsApps(apps: ConsoleApps | undefined): boolean {
  return apps !== undefined && apps !== '*';
}

const decisions = new WeakMap<object, ConsoleApps | undefined>();

/** Keeps what `authorize` granted for this request, for the scope read after the guard. */
export function rememberConsoleApps(request: unknown, apps: ConsoleApps | undefined): void {
  if (typeof request === 'object' && request !== null) decisions.set(request, apps);
}

/** What `authorize` granted for this request (`undefined`: every app, or not seen). */
export function consoleAppsFor(request: unknown): ConsoleApps | undefined {
  return typeof request === 'object' && request !== null ? decisions.get(request) : undefined;
}

/** The `?app=` of a request. */
export function requestedApp(request: unknown): string | undefined {
  const query = (request as { query?: Record<string, unknown> } | undefined)?.query;
  const value = query?.app;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** What `GET <api>/apps` answers: the header's "App" control. */
export interface ConsoleAppsInfo {
  /** Whether entries carry an app (a control plane), or the viewer is limited to some apps. */
  enabled: boolean;
  /** The tag prefix: `app`. */
  tag: string;
  /** Whether the viewer may see every app. */
  all: boolean;
  /** The app this view shows; `null` for every granted app. */
  selected: string | null;
  /** Apps to pick from (narrowed by `search`), with a label each. */
  apps: { id: string; label: string }[];
}

/** `apps` in `TelescopeModule.forRoot()`. */
export interface TelescopeAppsOptions {
  /** Labels of the App picker, by app id: a map, or a function given the ids it shows. */
  labels?:
    | Record<string, string>
    | ((ids: string[]) => Record<string, string> | Promise<Record<string, string>>);
}
