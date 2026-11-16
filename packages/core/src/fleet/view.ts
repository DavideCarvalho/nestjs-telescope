// packages/core/src/fleet/view.ts
import { EntryType } from '../entry/entry.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { CheckState } from './checks.js';
import type { CheckIncident, FleetApp } from './derive.js';
import type { FleetRegistry, InstanceReporter } from './registry.js';

/** An exception family recorded since a check went bad. */
export interface RelatedException {
  familyHash: string | null;
  class: string;
  message: string;
  count: number;
  /** The newest entry of the family (open it in the console). */
  entryId: string;
}

/** A check incident with the exceptions recorded since it started. */
export interface FleetIncident extends CheckIncident {
  exceptions: RelatedException[];
}

/** One app in the console's Fleet page. */
export interface FleetAppView extends Omit<FleetApp, 'checks'> {
  checks: FleetIncident[];
}

/** What `GET <path>/api/fleet` answers (and the `telescope_get_fleet` MCP tool). */
export interface FleetView {
  /** Whether this telescope keeps a fleet (a control plane, or a standalone app with `fleet` on). */
  enabled: boolean;
  /** Why the fleet is empty when it is not kept, or hidden from this viewer. */
  notice: string | null;
  /** Epoch ms the view was derived at. */
  now: number;
  apps: FleetAppView[];
  /** This process: its instance id, state and checks (`null` when it does not report). */
  self: { instanceId: string; state: string; role: string; checks: CheckState[] } | null;
}

/** What a fleet read is limited to. */
export interface FleetScope {
  /** The apps the viewer may see, `null` for all. */
  apps: readonly string[] | null;
  /**
   * The viewer is limited to some organizations: instances are infrastructure, shared by every
   * organization, so the fleet is not shown.
   */
  hidden?: boolean;
}

/** Options of {@link readFleet}. */
export interface ReadFleetOptions {
  fleet: FleetRegistry | null;
  reporter?: InstanceReporter | null;
  /** The live states of this process's checks. */
  selfChecks?: () => CheckState[];
  /** The (scoped) store the related exceptions are read from; `null` to skip them. */
  store?: StorageProvider | null;
  /** Whether an app's related exceptions are read by its `app:<id>` tag (a tenant's entries on a control plane). */
  tagByApp?: (app: string) => boolean;
  /** Related exception families per incident. Default 3. */
  topExceptions?: number;
}

/** The exception families recorded since `since`, most frequent first. */
async function relatedExceptions(
  store: StorageProvider,
  since: number,
  app: string | null,
  top: number,
): Promise<RelatedException[]> {
  const { data: entries } = await store.get({
    type: EntryType.Exception,
    after: new Date(since),
    limit: 500,
    ...(app !== null ? { tag: `app:${app}` } : {}),
  });
  const families = new Map<string, RelatedException>();
  for (const entry of entries) {
    const content = (entry.content ?? {}) as Record<string, unknown>;
    const key =
      entry.familyHash ?? `${String(content.name ?? content.class)}:${String(content.message)}`;
    const current = families.get(key);
    if (current !== undefined) {
      current.count += 1;
      continue;
    }
    families.set(key, {
      familyHash: entry.familyHash,
      class: String(content.name ?? content.class ?? 'Error'),
      message: String(content.message ?? '').slice(0, 300),
      count: 1,
      entryId: entry.id,
    });
  }
  return [...families.values()].sort((a, b) => b.count - a.count).slice(0, top);
}

/** The fleet as a viewer limited to `scope` sees it. */
export async function readFleet(scope: FleetScope, options: ReadFleetOptions): Promise<FleetView> {
  const now = Date.now();
  const reporter = options.reporter ?? null;
  const self =
    reporter !== null
      ? {
          instanceId: reporter.instanceId,
          state: reporter.currentState,
          role: reporter.role,
          checks: options.selfChecks?.() ?? [],
        }
      : null;
  if (options.fleet === null) {
    return {
      enabled: false,
      notice:
        'This telescope keeps no fleet: it runs on a control plane, or a standalone app with `fleet: true` (a tenant sends its heartbeat to the control plane).',
      now,
      apps: [],
      self,
    };
  }
  if (scope.hidden === true) {
    return {
      enabled: true,
      notice: 'Instances are shared by every organization: the fleet needs access to all of them.',
      now,
      apps: [],
      self: null,
    };
  }
  const apps = await options.fleet.view(scope.apps);
  const top = options.topExceptions ?? 3;
  const store = options.store ?? null;
  const views: FleetAppView[] = [];
  for (const app of apps) {
    const checks: FleetIncident[] = [];
    for (const incident of app.checks) {
      let exceptions: RelatedException[] = [];
      if (store !== null && incident.status !== 'unknown') {
        try {
          exceptions = await relatedExceptions(
            store,
            incident.since,
            options.tagByApp?.(app.app) ? app.app : null,
            top,
          );
        } catch {
          exceptions = [];
        }
      }
      checks.push({ ...incident, exceptions });
    }
    views.push({ ...app, checks });
  }
  return { enabled: true, notice: null, now, apps: views, self };
}
