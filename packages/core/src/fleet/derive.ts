// packages/core/src/fleet/derive.ts
//
// What follows from the instances' last heartbeats: who is up, deploys, restart loops, failing checks.
import type { CheckState, CheckStatus } from './checks.js';
import { type HeartbeatShipping, type InstanceState, WEB_ROLE } from './heartbeat.js';

/** One instance as the fleet store keeps it (one row per app + instance id). */
export interface InstanceRecord {
  app: string;
  instanceId: string;
  host: string;
  pid: number;
  version: string | null;
  /** Epoch ms. */
  bootedAt: number;
  /** Epoch ms of the first heartbeat received. */
  firstSeenAt: number;
  /** Epoch ms of the last heartbeat received. */
  lastSeenAt: number;
  state: InstanceState;
  intervalMs: number;
  checks: CheckState[];
  shipping: HeartbeatShipping | null;
  /** The URL the instance said other apps reach it at, or `null`. Absent from older rows. */
  url?: string | null;
  /** `web`, or a worker's name. Absent from older rows (and senders), which are web. */
  role?: string;
}

/** What the fleet says about an instance right now. */
export type InstanceStatus = 'up' | 'starting' | 'draining' | 'gone';

/** How the fleet is derived. */
export interface FleetDeriveOptions {
  /** An instance is gone after this many missed heartbeats. Default 3. */
  goneAfterIntervals: number;
  /** A restart loop: at least `restarts` boots on one host within `withinMs`. */
  restartLoop: { restarts: number; withinMs: number };
}

export const DEFAULT_DERIVE: FleetDeriveOptions = {
  goneAfterIntervals: 3,
  restartLoop: { restarts: 3, withinMs: 10 * 60_000 },
};

/** The status of one instance at `now`. */
export function instanceStatus(
  record: Pick<InstanceRecord, 'state' | 'lastSeenAt' | 'intervalMs'>,
  now: number,
  goneAfterIntervals = DEFAULT_DERIVE.goneAfterIntervals,
): InstanceStatus {
  if (now - record.lastSeenAt > record.intervalMs * goneAfterIntervals) return 'gone';
  if (record.state === 'ready') return 'up';
  return record.state;
}

/** One instance in the fleet view. */
export interface FleetInstance extends InstanceRecord {
  /** Always set in the view (`web` for an older row). */
  role: string;
  status: InstanceStatus;
  uptimeMs: number;
  /** Worst check status among this instance's checks (`ok` without checks). */
  health: CheckStatus;
}

export type InstanceCounts = Record<InstanceStatus, number>;

/** A version change across an app's instances. */
export interface DeployEvent {
  version: string | null;
  previous: string | null;
  /** Epoch ms the first instance of this version booted. */
  startedAt: number;
  /** Live (up, starting or draining) instances on this version. */
  live: number;
  /** Live instances in total. */
  total: number;
  /** `live / total` among live instances (0..1); 1 once nothing runs. */
  progress: number;
  /** Whether no live instance runs another version, or nothing runs any more (the rollout is over). */
  complete: boolean;
}

/** A host that keeps restarting (one process kind on it: its role). */
export interface RestartLoop {
  host: string;
  /** The role of the restarting processes (`web`, or a worker's name). */
  role: string;
  /** Boots within the window. */
  restarts: number;
  /** Epoch ms of the first boot in the window. */
  since: number;
  lastBootAt: number;
}

/** A check that is not ok on at least one live instance of an app. */
export interface CheckIncident {
  name: string;
  status: CheckStatus;
  /** Epoch ms since the earliest affected instance has been in this status. */
  since: number;
  message: string | null;
  /** Live instances where it is in this status, of those running it. */
  affected: number;
  of: number;
  critical: boolean;
}

/** One app in the fleet view. */
export interface FleetApp {
  app: string;
  counts: InstanceCounts;
  /** Versions running on live instances, most instances first. */
  versions: Array<{ version: string | null; instances: number }>;
  instances: FleetInstance[];
  deploys: DeployEvent[];
  restartLoops: RestartLoop[];
  checks: CheckIncident[];
  /** Sum of the live instances' shipping stats, or `null` when none ship entries. */
  shipping: { buffered: number; dropped: number; maxLagMs: number } | null;
  /** The counts per role (`web` first, then workers by name). */
  roles: Array<{ role: string; counts: InstanceCounts }>;
}

const RANK: Record<CheckStatus, number> = { ok: 0, unknown: 1, warn: 2, down: 3 };

function worst(checks: CheckState[]): CheckStatus {
  let result: CheckStatus = 'ok';
  for (const check of checks) if (RANK[check.status] > RANK[result]) result = check.status;
  return result;
}

const isLive = (status: InstanceStatus) => status === 'up' || status === 'starting';

/** The deploys of one app: each version change, oldest first, with rollout progress. */
export function deploysOf(instances: FleetInstance[]): DeployEvent[] {
  const firstBoot = new Map<string | null, number>();
  for (const instance of instances) {
    const known = firstBoot.get(instance.version);
    if (known === undefined || instance.bootedAt < known) {
      firstBoot.set(instance.version, instance.bootedAt);
    }
  }
  const ordered = [...firstBoot].sort((a, b) => a[1] - b[1]);
  // Draining instances still run their version (as in the versions list and the incidents).
  const live = instances.filter((i) => isLive(i.status) || i.status === 'draining');
  const deploys: DeployEvent[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const [version, startedAt] = ordered[index] as [string | null, number];
    const on = live.filter((i) => i.version === version).length;
    deploys.push({
      version,
      previous: (ordered[index - 1] as [string | null, number])[0],
      startedAt,
      live: on,
      total: live.length,
      // Nothing running any more: the rollout is over (not stuck at 0/0).
      progress: live.length === 0 ? 1 : on / live.length,
      complete: live.length === 0 || on === live.length,
    });
  }
  return deploys;
}

/**
 * Hosts with at least `restarts` boots of one role within `withinMs` before `now`. Counted per host
 * and role: one container booting its web process and a worker is not two restarts.
 */
export function restartLoopsOf(
  instances: Array<Pick<InstanceRecord, 'host' | 'bootedAt'> & { role?: string | undefined }>,
  now: number,
  options: FleetDeriveOptions['restartLoop'] = DEFAULT_DERIVE.restartLoop,
): RestartLoop[] {
  const boots = new Map<string, { host: string; role: string; times: number[] }>();
  for (const instance of instances) {
    if (now - instance.bootedAt > options.withinMs) continue;
    const role = instance.role ?? WEB_ROLE;
    const key = `${instance.host}\u0000${role}`;
    const group = boots.get(key) ?? { host: instance.host, role, times: [] };
    group.times.push(instance.bootedAt);
    boots.set(key, group);
  }
  const loops: RestartLoop[] = [];
  for (const { host, role, times } of boots.values()) {
    if (times.length < options.restarts) continue;
    loops.push({
      host,
      role,
      restarts: times.length,
      since: Math.min(...times),
      lastBootAt: Math.max(...times),
    });
  }
  return loops.sort(
    (a, b) =>
      b.restarts - a.restarts || a.host.localeCompare(b.host) || compareRoles(a.role, b.role),
  );
}

/** `web` first, then workers by name. */
export function compareRoles(a: string, b: string): number {
  if (a === b) return 0;
  if (a === WEB_ROLE) return -1;
  if (b === WEB_ROLE) return 1;
  return a.localeCompare(b);
}

/** Checks that are not ok on a live instance, worst first. */
export function checkIncidentsOf(instances: FleetInstance[]): CheckIncident[] {
  const live = instances.filter((i) => isLive(i.status) || i.status === 'draining');
  const byName = new Map<string, CheckIncident>();
  const running = new Map<string, number>();
  for (const instance of live) {
    for (const check of instance.checks) {
      running.set(check.name, (running.get(check.name) ?? 0) + 1);
      if (check.status === 'ok') continue;
      const current = byName.get(check.name);
      if (current === undefined || RANK[check.status] > RANK[current.status]) {
        byName.set(check.name, {
          name: check.name,
          status: check.status,
          since: check.since,
          message: check.message,
          affected: 1,
          of: 0,
          critical: check.critical,
        });
      } else if (check.status === current.status) {
        current.affected += 1;
        if (check.since < current.since) {
          current.since = check.since;
          current.message = check.message ?? current.message;
        }
      }
    }
  }
  return [...byName.values()]
    .map((incident) => ({ ...incident, of: running.get(incident.name) ?? incident.affected }))
    .sort((a, b) => RANK[b.status] - RANK[a.status] || a.since - b.since);
}

/** Group instance rows into the per-app fleet view at `now`. */
export function deriveFleet(
  records: InstanceRecord[],
  now: number,
  options: FleetDeriveOptions = DEFAULT_DERIVE,
): FleetApp[] {
  const byApp = new Map<string, FleetInstance[]>();
  for (const record of records) {
    const status = instanceStatus(record, now, options.goneAfterIntervals);
    const instance: FleetInstance = {
      ...record,
      role: record.role ?? WEB_ROLE,
      status,
      uptimeMs: Math.max(0, (status === 'gone' ? record.lastSeenAt : now) - record.bootedAt),
      health: worst(record.checks),
    };
    const list = byApp.get(record.app) ?? [];
    list.push(instance);
    byApp.set(record.app, list);
  }
  const apps: FleetApp[] = [];
  for (const [app, instances] of byApp) {
    const counts: InstanceCounts = { up: 0, starting: 0, draining: 0, gone: 0 };
    const roles = new Map<string, InstanceCounts>();
    const versions = new Map<string | null, number>();
    let shipping: FleetApp['shipping'] = null;
    for (const instance of instances) {
      counts[instance.status] += 1;
      let roleCounts = roles.get(instance.role);
      if (roleCounts === undefined) {
        roleCounts = { up: 0, starting: 0, draining: 0, gone: 0 };
        roles.set(instance.role, roleCounts);
      }
      roleCounts[instance.status] += 1;
      if (instance.status === 'gone') continue;
      versions.set(instance.version, (versions.get(instance.version) ?? 0) + 1);
      if (instance.shipping !== null) {
        shipping ??= { buffered: 0, dropped: 0, maxLagMs: 0 };
        shipping.buffered += instance.shipping.buffered;
        shipping.dropped += instance.shipping.dropped;
        shipping.maxLagMs = Math.max(shipping.maxLagMs, instance.shipping.lagMs);
      }
    }
    const order: Record<InstanceStatus, number> = { up: 0, starting: 1, draining: 2, gone: 3 };
    instances.sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        a.host.localeCompare(b.host) ||
        b.bootedAt - a.bootedAt,
    );
    apps.push({
      app,
      counts,
      versions: [...versions]
        .map(([version, n]) => ({ version, instances: n }))
        .sort((a, b) => b.instances - a.instances),
      instances,
      deploys: deploysOf(instances),
      restartLoops: restartLoopsOf(instances, now, options.restartLoop),
      checks: checkIncidentsOf(instances),
      shipping,
      roles: [...roles]
        .sort(([a], [b]) => compareRoles(a, b))
        .map(([role, roleCounts]) => ({ role, counts: roleCounts })),
    });
  }
  return apps.sort((a, b) => a.app.localeCompare(b.app));
}
