// packages/core/src/alerts/fleet-rules.ts
import { durationToMs } from '../config/parse-duration.js';
import type { FleetApp } from '../fleet/derive.js';
import { WEB_ROLE } from '../fleet/heartbeat.js';
import type { FleetAlertContext, FleetAlertRule } from './alert-rule.js';

/** The read the fleet rules need: the derived fleet (`FleetRegistry` fits). */
export interface FleetSource {
  view(apps?: readonly string[] | null): Promise<FleetApp[]>;
}

/** One subject of a fleet rule (an app, an app's check, a host) and whether it crosses now. */
export interface FleetOutcome {
  /** Stable per rule: `<app>`, `<app>\u0000<check>`, `<app>\u0000<host>`. */
  key: string;
  crosses: boolean;
  value: number;
  threshold: number;
  fleet: FleetAlertContext;
}

/** An app no instance reported for: nothing is up. */
const EMPTY = {
  app: '',
  counts: { up: 0, starting: 0, draining: 0, gone: 0 },
  roles: [],
} as unknown as FleetApp;

/** The most instances (and `instances-up` holds) the evaluator tracks at once. */
const MAX_TRACKED = 20_000;

const minutes = (ms: number) => {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
};

/**
 * Evaluates the fleet rules over the derived fleet. Holds what a rule needs across evaluations:
 * when `instances-up` started crossing (its `for`), and the drop counters `entries-dropped`
 * compares over its window.
 */
export class FleetRuleEvaluator {
  /** `<rule>\u0000<key>` → epoch ms the condition started holding. */
  private readonly holding = new Map<string, number>();
  /** `<app>\u0000<instance>` → drop counter samples, oldest first. */
  private readonly drops = new Map<string, Array<{ at: number; dropped: number }>>();

  constructor(private readonly source: FleetSource) {}

  /** Every subject of `rule` at `now`. */
  async evaluate(rule: FleetAlertRule, ruleKey: string, now: number): Promise<FleetOutcome[]> {
    const fleet = await this.source.view(rule.app !== undefined ? [rule.app] : null);
    switch (rule.type) {
      case 'instances-up':
        return this.instancesUp(rule, ruleKey, fleet, now);
      case 'restart-loop':
        // One subject per looping host (`<app>\u0000<host>`): two hosts looping at once page twice,
        // and each resolves on its own once it settles (the subject leaves the outcomes).
        // Loops are per host and role; a web loop keeps its key from before roles.
        return fleet.flatMap((app) =>
          app.restartLoops.map((loop) => {
            const role = loop.role ?? WEB_ROLE;
            const worker = role !== WEB_ROLE;
            return {
              key: `${app.app}\u0000${loop.host}${worker ? `\u0000${role}` : ''}`,
              crosses: true,
              value: loop.restarts,
              threshold: loop.restarts,
              fleet: {
                app: app.app,
                host: loop.host,
                detail: `${loop.host}${worker ? ` (${role})` : ''} restarted ${loop.restarts} times in ${minutes(Math.max(0, now - loop.since))}`,
              },
            };
          }),
        );
      case 'check-down':
        return this.checkDown(rule, fleet, now);
      case 'entries-dropped':
        return this.entriesDropped(rule, fleet, now);
    }
  }

  private instancesUp(
    rule: Extract<FleetAlertRule, { type: 'instances-up' }>,
    ruleKey: string,
    fleet: FleetApp[],
    now: number,
  ): FleetOutcome[] {
    const holdMs = durationToMs(rule.for ?? '1m');
    const role = rule.role ?? WEB_ROLE;
    // An app's up instances of the rule's role, or `null` when it runs none of them. Without a
    // `role`, an app's web instances count, and an app that only runs workers counts its workers
    // (as before roles existed). A fleet from a source without roles counts as web.
    const upOf = (app: FleetApp): number | null => {
      if (role === '*' || app.roles === undefined) return app.counts.up;
      const counts = app.roles.find((entry) => entry.role === role)?.counts;
      if (counts !== undefined) return counts.up;
      if (rule.role === undefined && !app.roles.some((entry) => entry.role === WEB_ROLE)) {
        return app.counts.up;
      }
      return null;
    };
    const apps =
      rule.app !== undefined
        ? [{ app: rule.app, up: upOf(fleet.find((a) => a.app === rule.app) ?? EMPTY) ?? 0 }]
        : fleet.flatMap((a) => {
            // Without `app`: only the apps that run this role.
            const up = upOf(a);
            return up === null ? [] : [{ app: a.app, up }];
          });
    return apps.map(({ app, up }) => {
      const below = up < rule.below;
      const holdKey = `${ruleKey}\u0000${app}`;
      let crosses = false;
      if (below) {
        const since = this.holding.get(holdKey) ?? now;
        this.holding.set(holdKey, since);
        while (this.holding.size > MAX_TRACKED) {
          this.holding.delete(this.holding.keys().next().value as string);
        }
        crosses = now - since >= holdMs;
      } else {
        this.holding.delete(holdKey);
      }
      return {
        key: app,
        crosses,
        value: up,
        threshold: rule.below,
        fleet: {
          app,
          detail:
            up === 0
              ? `no ${role === '*' || role === WEB_ROLE ? '' : `${role} `}instance is up`
              : `${up} ${role === '*' || role === WEB_ROLE ? '' : `${role} `}instance${up === 1 ? '' : 's'} up (expected at least ${rule.below})`,
        },
      };
    });
  }

  private checkDown(
    rule: Extract<FleetAlertRule, { type: 'check-down' }>,
    fleet: FleetApp[],
    now: number,
  ): FleetOutcome[] {
    const forMs = durationToMs(rule.for);
    const outcomes: FleetOutcome[] = [];
    for (const app of fleet) {
      const names = new Set<string>();
      for (const instance of app.instances) for (const c of instance.checks) names.add(c.name);
      if (rule.check !== undefined) names.add(rule.check);
      for (const name of names) {
        if (rule.check !== undefined && name !== rule.check) continue;
        const incident = app.checks.find((c) => c.name === name && c.status === 'down');
        // `since` comes from the sender's clock: a clock ahead of ours must not read as a negative age.
        const downMs = incident !== undefined ? Math.max(0, now - incident.since) : 0;
        outcomes.push({
          key: `${app.app}\u0000${name}`,
          crosses: incident !== undefined && downMs >= forMs,
          value: Math.round(downMs / 1000),
          threshold: Math.round(forMs / 1000),
          fleet: {
            app: app.app,
            check: name,
            detail:
              incident !== undefined
                ? `${name}: down for ${minutes(downMs)} on ${incident.affected} of ${incident.of} instance${incident.of === 1 ? '' : 's'}${incident.message ? ` (${incident.message})` : ''}`
                : `${name}: ok`,
          },
        });
      }
    }
    return outcomes;
  }

  private entriesDropped(
    rule: Extract<FleetAlertRule, { type: 'entries-dropped' }>,
    fleet: FleetApp[],
    now: number,
  ): FleetOutcome[] {
    const windowMs = durationToMs(rule.window);
    const threshold = rule.threshold ?? 1;
    const outcomes: FleetOutcome[] = [];
    for (const app of fleet) {
      let dropped = 0;
      for (const instance of app.instances) {
        if (instance.shipping === null) continue;
        const key = `${app.app}\u0000${instance.instanceId}`;
        const samples = this.drops.get(key) ?? [];
        // Re-insert: the map's order is least recently sampled first.
        this.drops.delete(key);
        const last = samples[samples.length - 1];
        if (last === undefined || last.at !== instance.lastSeenAt) {
          samples.push({ at: instance.lastSeenAt, dropped: instance.shipping.dropped });
        }
        while (samples.length > 1 && (samples[0] as { at: number }).at < now - windowMs) {
          samples.shift();
        }
        this.drops.set(key, samples);
        const first = samples[0] as { at: number; dropped: number };
        const latest = samples[samples.length - 1] as { at: number; dropped: number };
        // A new process counts from 0: its first sample inside the window counts whole.
        // A process that booted inside the window dropped everything it counts inside it: its
        // counter counts whole for as long as the boot stays in the window.
        const base = instance.bootedAt >= now - windowMs ? 0 : first.dropped;
        dropped += Math.max(0, latest.dropped - base);
      }
      outcomes.push({
        key: app.app,
        crosses: dropped >= threshold,
        value: dropped,
        threshold,
        fleet: {
          app: app.app,
          detail: `${dropped} entr${dropped === 1 ? 'y' : 'ies'} dropped in ${rule.window}`,
        },
      });
    }
    // Bounded by evicting the least recently sampled instance: an instance still reporting is
    // re-sampled every evaluation, so a sender rotating instance ids only evicts its own stale ones
    // (never a wholesale clear, which would reset every app's baseline at once).
    while (this.drops.size > MAX_TRACKED) {
      this.drops.delete(this.drops.keys().next().value as string);
    }
    return outcomes;
  }
}
