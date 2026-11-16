// packages/core/src/discovery/server.ts
//
// The control plane's half: the discovery map, built from the fleet. An app is in it once one of
// its instances sent a URL with its heartbeat (`fleet.url`, default `APP_URL`); its `url` is the
// most recently seen live instance's, and `live` counts the instances up right now.
//
// Scoped by the caller's verified token: capabilities absent (an HMAC token) or listing
// `telescope:discovery` see every app; `telescope:discovery:<app>` entries see those apps only.
import { createHash } from 'node:crypto';
import { type FleetDeriveOptions, type InstanceRecord, instanceStatus } from '../fleet/derive.js';
import type { VerifiedTenant } from '../topology/tenant-auth.js';
import { isAppName } from './config.js';
import type { DiscoveredApp, DiscoveryMap } from './directory.js';

/** The capability that lets a token read the whole discovery map. */
export const TELESCOPE_DISCOVERY_CAPABILITY = 'telescope:discovery';

/** Which apps a caller may see: `'*'`, some, or `null` (no discovery for this token). */
export type DiscoveryScope = '*' | ReadonlySet<string>;

/** The scope a verified token grants, or `null` when it grants no discovery at all. */
export function discoveryScopeOf(tenant: VerifiedTenant): DiscoveryScope | null {
  const capabilities = tenant.capabilities;
  if (capabilities === undefined || capabilities.includes(TELESCOPE_DISCOVERY_CAPABILITY)) {
    return '*';
  }
  const prefix = `${TELESCOPE_DISCOVERY_CAPABILITY}:`;
  const apps = capabilities
    .filter((capability) => capability.startsWith(prefix) && capability.length > prefix.length)
    .map((capability) => capability.slice(prefix.length).toLowerCase());
  return apps.length > 0 ? new Set(apps) : null;
}

function scopeKey(scope: DiscoveryScope): string {
  return scope === '*' ? '*' : [...scope].sort().join(',');
}

/** The map a caller with `scope` sees, at `now`. */
export function buildDiscoveryMap(
  instances: readonly InstanceRecord[],
  scope: DiscoveryScope,
  now: number,
  goneAfterIntervals: number,
): DiscoveryMap {
  const byApp = new Map<
    string,
    { url: string; lastSeenAt: number; live: number; liveUrl: boolean }
  >();
  for (const instance of instances) {
    const name = instance.app.toLowerCase();
    if (!isAppName(name) || typeof instance.url !== 'string' || instance.url === '') continue;
    if (scope !== '*' && !scope.has(name)) continue;
    const up = instanceStatus(instance, now, goneAfterIntervals) === 'up';
    const seen = byApp.get(name);
    if (seen === undefined) {
      byApp.set(name, {
        url: instance.url,
        lastSeenAt: instance.lastSeenAt,
        live: up ? 1 : 0,
        liveUrl: up,
      });
      continue;
    }
    if (up) seen.live += 1;
    // The most recently seen live instance's URL wins; a live one beats any gone one.
    if ((up && !seen.liveUrl) || (up === seen.liveUrl && instance.lastSeenAt > seen.lastSeenAt)) {
      seen.url = instance.url;
      seen.lastSeenAt = instance.lastSeenAt;
      seen.liveUrl = up;
    }
  }
  const apps: Record<string, DiscoveredApp> = Object.create(null);
  for (const name of [...byApp.keys()].sort()) {
    const app = byApp.get(name) as { url: string; live: number };
    apps[name] = { url: app.url, live: app.live };
  }
  const version = createHash('sha256').update(JSON.stringify(apps)).digest('hex').slice(0, 16);
  return { version, apps };
}

/** Options of {@link DiscoveryPublisher}. */
export interface DiscoveryPublisherOptions {
  /** The fleet's instances (within the retention). */
  instances: () => Promise<InstanceRecord[]>;
  derive: Pick<FleetDeriveOptions, 'goneAfterIntervals'>;
  /** How often held callers are re-checked. Default 1000 ms. */
  tickMs?: number;
  now?: () => number;
}

interface Waiter {
  scope: DiscoveryScope;
  since: string;
  deadline: number;
  resolve: (map: DiscoveryMap) => void;
}

/**
 * Serves the map, and holds a caller that already has the current version until it changes (long
 * poll): one read of the fleet per tick, shared by every held caller, and an immediate re-check on
 * each heartbeat ({@link poke}).
 */
export class DiscoveryPublisher {
  private readonly waiters = new Set<Waiter>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: DiscoveryPublisherOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The map for `scope` now. */
  async current(scope: DiscoveryScope): Promise<DiscoveryMap> {
    return buildDiscoveryMap(
      await this.options.instances(),
      scope,
      this.now(),
      this.options.derive.goneAfterIntervals,
    );
  }

  /**
   * The map for `scope`: at once when its version is not `since`, else when it changes, or after
   * `waitMs` (the same version again). `signal` aborts the wait (the caller hung up).
   */
  async wait(
    scope: DiscoveryScope,
    since: string | null,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<DiscoveryMap> {
    const map = await this.current(scope);
    if (since === null || map.version !== since || waitMs <= 0 || signal?.aborted) return map;
    return new Promise<DiscoveryMap>((resolve) => {
      const waiter: Waiter = { scope, since, deadline: this.now() + waitMs, resolve };
      this.waiters.add(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          if (this.waiters.delete(waiter)) resolve(map);
        },
        { once: true },
      );
      this.ensureTimer();
    });
  }

  /** Callers held right now. */
  get pending(): number {
    return this.waiters.size;
  }

  /** Re-check the held callers now (a heartbeat arrived). */
  poke(): void {
    if (this.waiters.size > 0) void this.tick();
  }

  /** Answer every held caller with the current map, and stop. */
  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) {
      try {
        waiter.resolve(await this.current(waiter.scope));
      } catch {
        waiter.resolve({ version: waiter.since, apps: {} });
      }
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 1000);
    this.timer.unref?.();
  }

  private tick(): Promise<void> {
    if (this.ticking !== null) return this.ticking;
    const run = (async () => {
      let instances: InstanceRecord[];
      try {
        instances = await this.options.instances();
      } catch {
        return;
      }
      const now = this.now();
      const maps = new Map<string, DiscoveryMap>();
      for (const waiter of [...this.waiters]) {
        const key = scopeKey(waiter.scope);
        let map = maps.get(key);
        if (map === undefined) {
          map = buildDiscoveryMap(
            instances,
            waiter.scope,
            now,
            this.options.derive.goneAfterIntervals,
          );
          maps.set(key, map);
        }
        if (map.version !== waiter.since || now >= waiter.deadline) {
          this.waiters.delete(waiter);
          waiter.resolve(map);
        }
      }
      if (this.waiters.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    })().finally(() => {
      this.ticking = null;
    });
    this.ticking = run;
    return run;
  }
}
