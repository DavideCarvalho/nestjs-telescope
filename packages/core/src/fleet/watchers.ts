// packages/core/src/fleet/watchers.ts
//
// Which watchers recorded the entries a control plane's console shows: the tenants', from their
// heartbeats, never the control plane's own list alone.
import type { InstanceRecord } from './derive.js';

/** Inputs of {@link fleetWatchers}. */
export interface FleetWatchersInput {
  /** The instances of the apps in view (already narrowed to them). */
  instances: readonly Pick<InstanceRecord, 'app' | 'lastSeenAt' | 'watchers'>[];
  /** Instances last seen before this (epoch ms) are left out: their entries are pruned by now. */
  since: number;
  /**
   * Watchers known to run besides those instances (the control plane's own, when every app is in
   * view, since its own entries are shown too), or `null` when none are known that way.
   */
  own: readonly string[] | null;
}

/**
 * The watchers behind the entries in view, on a server that collects several apps: the union of
 * what each app's instances report.
 *
 * `null` (unknown) when an app in view has instances but none of them says which watchers it runs
 * (an older sender), or when nothing at all is known: a panel must not claim a watcher is off for
 * an app that never said. Within one app, instances that do not report are ignored as soon as one
 * of them does (an old process still within the window after an upgrade).
 */
export function fleetWatchers(input: FleetWatchersInput): string[] | null {
  const byApp = new Map<string, Set<string> | null>();
  for (const instance of input.instances) {
    if (instance.lastSeenAt < input.since) continue;
    if (instance.watchers === undefined) {
      if (!byApp.has(instance.app)) byApp.set(instance.app, null);
      continue;
    }
    const names = byApp.get(instance.app) ?? new Set<string>();
    for (const name of instance.watchers) names.add(name);
    byApp.set(instance.app, names);
  }
  if (byApp.size === 0 && input.own === null) return null;
  const union = new Set<string>(input.own ?? []);
  for (const names of byApp.values()) {
    if (names === null) return null;
    for (const name of names) union.add(name);
  }
  return [...union].sort();
}

/** Inputs of {@link consoleWatchers}. */
export interface ConsoleWatchersInput {
  /** Whether this process is a control plane (the entries on screen are the tenants'). */
  controlPlane: boolean;
  /** The fleet's instances of `apps` (`null`: every app), or `null` when the fleet is off. */
  instances: ((apps: readonly string[] | null) => Promise<FleetWatchersInput['instances']>) | null;
  /** The apps in view, or `null` for every app. */
  apps: readonly string[] | null;
  /** The control plane's own app: its instances are covered by `own`. */
  selfApp: string | null;
  /** See {@link FleetWatchersInput.since}. */
  since: number;
  /** This process's own watchers. */
  own: () => readonly string[];
  /**
   * The watchers this process runs for its tenants (`durable` on a durable control plane): on for
   * every app in view, whatever its instances report.
   */
  forTenants?: () => readonly string[];
}

/**
 * What `GET meta` answers for `watchers`: `undefined` outside a control plane (the process's own
 * list stands); on a control plane the union the instances of the apps in view report, or `null`
 * (unknown) when the fleet is off or cannot be read. Never the control plane's own list alone,
 * which says nothing about the tenants whose entries are on screen.
 */
export async function consoleWatchers(
  input: ConsoleWatchersInput,
): Promise<string[] | null | undefined> {
  if (!input.controlPlane) return undefined;
  if (input.instances === null) return null;
  try {
    const instances = (await input.instances(input.apps)).filter(
      (instance) => instance.app !== '' && instance.app !== input.selfApp,
    );
    const watchers = fleetWatchers({
      instances,
      since: input.since,
      own: input.apps === null ? input.own() : null,
    });
    // Unknown stays unknown: naming only the tenant watchers would claim the rest are off.
    const forTenants = input.forTenants?.() ?? [];
    if (watchers === null || forTenants.length === 0) return watchers;
    return [...new Set([...watchers, ...forTenants])].sort();
  } catch {
    return null;
  }
}
