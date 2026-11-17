// packages/core/src/fleet/fleet.service.ts
//
// The fleet in a Nest app: this process's checks and heartbeat, and (on a control plane, or a
// standalone app with `fleet` on) the registry of every instance's last heartbeat.
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  type UptimeCheckState,
  publishCheckStates,
  publishedCheckStates,
} from '../alerts/integrations/check-states.js';
import type { ResolvedCoreConfig } from '../config/options.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_OPTIONS,
  TELESCOPE_STORAGE,
  type TelescopeModuleOptions,
} from '../nest/telescope.options.js';
import { TelescopeService } from '../nest/telescope.service.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { resolveTopology } from '../topology/config.js';
import type { ShippingStats } from '../topology/remote-store.js';
import { type CheckState, HealthChecks, type HealthReport } from './checks.js';
import {
  type ResolvedFleetConfig,
  resolveFleetConfig,
  resolveSelfApp,
  resolveVersion,
} from './config.js';
import {
  type HeartbeatShipping,
  type InstanceState,
  WEB_ROLE,
  normalizeHeartbeat,
} from './heartbeat.js';
import { FleetRegistry, InstanceReporter } from './registry.js';
import { MemoryFleetStore } from './store.js';
import { type FleetScope, type FleetView, readFleet } from './view.js';
import { consoleWatchers } from './watchers.js';
import { markedFleetWorkers } from './worker-marks.js';

/** The tenant store's shipping counters, read through the storage proxies. */
interface ShippingSource {
  stats(): ShippingStats;
  setHeartbeat(heartbeat: unknown): void;
}

function isShippingSource(storage: unknown): storage is ShippingSource {
  const s = storage as Partial<ShippingSource> | null;
  return typeof s?.stats === 'function' && typeof s.setHeartbeat === 'function';
}

const CHECK_RANK = { ok: 0, unknown: 1, warn: 2, down: 3 } as const;

/** What the readiness probe answers. */
export interface ReadinessReport extends HealthReport {
  /** `false` while a critical check is down or the instance is draining. */
  ready: boolean;
  state: string;
  /** `web`, or this worker's name. */
  role: string;
}

@Injectable()
export class TelescopeFleet
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown, OnModuleDestroy
{
  private readonly logger = new Logger('TelescopeFleet');
  readonly config: ResolvedFleetConfig;
  /** This process's checks (empty without `checks`). */
  readonly checks: HealthChecks;
  /** Every instance's last heartbeat: a control plane, or a standalone app with `fleet` on. */
  readonly registry: FleetRegistry | null;
  /** This process's heartbeat, when it reports one. */
  reporter: InstanceReporter | null = null;
  private readonly kind: 'standalone' | 'control-plane' | 'tenant';
  private selfApp: string | null = null;
  private draining = false;
  /** The check-state source this module published, if any. */
  private published: (() => Promise<UptimeCheckState[]>) | null = null;
  /** Starts this process's reporter as `role` (set once the fleet is on). */
  private startReporter: ((role: string, state: InstanceState) => void) | null = null;
  /** A worker that is not marked waits `workerAfter` before reporting. */
  private workerTimer: ReturnType<typeof setTimeout> | null = null;
  /** Signal listeners a worker added (removed at shutdown). */
  private signalListeners: Array<[NodeJS.Signals, () => void]> = [];

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_CONFIG) private readonly core: ResolvedCoreConfig,
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Inject(TelescopeService) private readonly service: TelescopeService,
    @Optional() @Inject(HttpAdapterHost) private readonly adapterHost?: HttpAdapterHost,
  ) {
    this.kind = resolveTopology(options).kind;
    this.config = resolveFleetConfig(options.fleet, this.kind !== 'standalone');
    this.checks = new HealthChecks(options.checks ?? []);
    this.registry =
      this.config.enabled && this.kind !== 'tenant'
        ? new FleetRegistry(this.config.store ?? new MemoryFleetStore(), {
            derive: {
              goneAfterIntervals: this.config.goneAfterIntervals,
              restartLoop: this.config.restartLoop,
            },
            retentionMs: this.config.retentionMs,
            onError: (error) =>
              this.logger.warn(
                `fleet store: ${error instanceof Error ? error.message : String(error)}`,
              ),
          })
        : null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.core.enabled) return;
    // Heartbeats, status pages and the uptime endpoint of `alerts` read these states (unless
    // `alerts.checkStates` names a source of its own).
    if (this.registry !== null || this.checks.size > 0) {
      this.published = () => this.checkStates();
      publishCheckStates(this.published);
    }
    if (!this.config.enabled) return;
    const tenantStore =
      this.kind === 'tenant' && isShippingSource(this.storage) ? this.storage : null;
    if (this.kind !== 'tenant') this.selfApp = await resolveSelfApp(this.config.app);
    this.registry?.startPruning();
    this.service.setFleetSource(this.registry);
    this.startReporter = (role, state) => {
      if (this.reporter !== null) return;
      const worker = role !== WEB_ROLE;
      this.reporter = new InstanceReporter({
        intervalMs: this.config.intervalMs,
        host: this.config.host,
        version: () => resolveVersion(this.config.version),
        checks: this.checks.size > 0 ? this.checks : null,
        shipping: tenantStore ? () => shippingOf(tenantStore.stats()) : () => null,
        // A worker serves no traffic: service discovery never routes to it.
        url: worker ? null : this.config.url,
        role,
        // So a control plane can tell which entry types this app records at all.
        watchers: () => this.service.enabledWatchers(),
        initialState: state,
        send: (heartbeat) => {
          if (tenantStore) tenantStore.setHeartbeat(heartbeat);
          else if (this.registry && this.selfApp)
            return this.registry.beat(this.selfApp, heartbeat);
        },
        onError: (error) =>
          this.logger.warn(`heartbeat: ${error instanceof Error ? error.message : String(error)}`),
      });
      if (worker) this.watchSignals();
      this.reporter.start();
    };
    // An HTTP server reports from boot (`starting`, then `ready`). A process without one is
    // decided once the app has booted (its workers are registered by then).
    if (this.processKind() === 'web' && this.config.report.web) {
      this.startReporter(this.config.role ?? WEB_ROLE, 'starting');
    }
  }

  /** `web` when this process serves HTTP (or `fleet.role` is `web`), else `worker`. */
  private processKind(): 'web' | 'worker' {
    if (this.config.role !== null) return this.config.role === WEB_ROLE ? 'web' : 'worker';
    return this.adapterHost?.httpAdapter ? 'web' : 'worker';
  }

  /**
   * The app has booted: `ready`. A process without an HTTP server reports as a worker once it has
   * run for `workerAfter` (so a short command never becomes an instance), named after what marked
   * it (`bullmq`, `bullmq+durable`) or `worker`; with `fleet.role` it reports right away.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.reporter !== null) {
      await this.reporter.setState('ready');
      return;
    }
    const start = this.startReporter;
    if (start === null || this.processKind() !== 'worker' || !this.config.report.worker) return;
    if (this.config.role !== null) {
      start(this.config.role, 'ready');
      return;
    }
    this.workerTimer = setTimeout(() => {
      this.workerTimer = null;
      if (this.draining) return;
      start(markedFleetWorkers().join('+').slice(0, 64) || 'worker', 'ready');
    }, this.config.workerAfterMs);
    this.workerTimer.unref?.();
  }

  /**
   * A worker drains on SIGTERM / SIGINT even when the app does not enable Nest's shutdown hooks:
   * the listener only observes (it runs first), and when it is the only one it re-raises the
   * signal once removed, so the process exits as it would have without it.
   */
  private watchSignals(): void {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const listener = (): void => {
        const alone = process.listenerCount(signal) === 1;
        this.unwatchSignals();
        this.draining = true;
        const beat = this.reporter?.setState('draining') ?? Promise.resolve();
        if (alone) {
          void beat.finally(() => {
            this.reporter?.stop();
            process.kill(process.pid, signal);
          });
        }
      };
      process.prependListener(signal, listener);
      this.signalListeners.push([signal, listener]);
    }
  }

  private unwatchSignals(): void {
    for (const [signal, listener] of this.signalListeners) process.removeListener(signal, listener);
    this.signalListeners = [];
  }

  /** Shutdown began: `draining` (readiness answers 503), sent before the final flush. */
  async beforeApplicationShutdown(): Promise<void> {
    this.draining = true;
    if (this.workerTimer !== null) clearTimeout(this.workerTimer);
    this.workerTimer = null;
    this.unwatchSignals();
    await this.reporter?.setState('draining');
    this.reporter?.stop();
  }

  onModuleDestroy(): void {
    if (this.workerTimer !== null) clearTimeout(this.workerTimer);
    this.workerTimer = null;
    this.unwatchSignals();
    this.reporter?.stop();
    this.registry?.stop();
    // Only unpublish our own source (another module may have published since).
    if (this.published !== null && publishedCheckStates() === this.published) {
      publishCheckStates(null);
    }
    this.published = null;
  }

  /**
   * The check states the alert integrations read (heartbeats, status pages, `uptimeHandler()`).
   * With a fleet: per app, each check's worst state on its live instances, plus an `instances`
   * check that is down while the app has no instance up or starting, so an app whose every
   * instance is gone fails its heartbeat. Without one (a tenant, or a standalone app with
   * `checks` and no fleet): this process's checks, run as needed (cached).
   */
  async checkStates(): Promise<UptimeCheckState[]> {
    if (this.registry === null) {
      const app = this.kind === 'tenant' ? this.options.tenant?.partition : this.selfApp;
      return (await this.checks.run()).map((state) => ({
        name: state.name,
        status: state.status,
        ...(app ? { app } : {}),
        message: state.message,
        since: state.since,
        critical: state.critical,
      }));
    }
    const states: UptimeCheckState[] = [];
    for (const app of await this.registry.view()) {
      // The web instances decide (a live worker must not hide a web outage); an app that only
      // runs workers follows its workers.
      const counts = app.roles.find((entry) => entry.role === WEB_ROLE)?.counts ?? app.counts;
      const serving = counts.up + counts.starting;
      const known = serving + counts.draining + counts.gone;
      states.push({
        name: 'instances',
        app: app.app,
        status: serving > 0 ? 'ok' : 'down',
        // The same count as the status: an instance still starting is serving (a deploy).
        message: `${serving} of ${known} ${app.roles.some((entry) => entry.role === WEB_ROLE) ? '' : 'worker '}instance${known === 1 ? '' : 's'} up or starting`,
        critical: true,
      });
      const byName = new Map<string, UptimeCheckState>();
      for (const instance of app.instances) {
        if (instance.status === 'gone') continue;
        for (const check of instance.checks) {
          const current = byName.get(check.name);
          if (current === undefined || CHECK_RANK[check.status] > CHECK_RANK[current.status]) {
            byName.set(check.name, {
              name: check.name,
              app: app.app,
              status: check.status,
              message: check.message,
              since: check.since,
              critical: check.critical,
            });
          }
        }
      }
      states.push(...byName.values());
    }
    return states;
  }

  /**
   * Takes a heartbeat a tenant sent with its batch. `app` comes from the verified token, never
   * from the heartbeat. A control plane without a fleet ignores it.
   */
  async heartbeat(app: string, raw: unknown): Promise<void> {
    if (this.registry === null) return;
    const heartbeat = normalizeHeartbeat(raw);
    if (heartbeat !== null) await this.registry.beat(app, heartbeat);
  }

  /**
   * The apps of a control plane's instance registry (one row per instance, within the fleet's
   * retention): the tenants that heartbeat, which the App picker lists without counting tags.
   * The control plane's own app is left out (its entries carry no `app:` tag, so picking it would
   * show nothing). `null` when there is no registry to read: any other topology, or `fleet: false`.
   */
  async instanceApps(): Promise<string[] | null> {
    if (this.kind !== 'control-plane' || this.registry === null) return null;
    const apps = new Set<string>();
    for (const instance of await this.registry.instances()) {
      if (instance.app !== '' && instance.app !== this.selfApp) apps.add(instance.app);
    }
    return [...apps];
  }

  /**
   * What `GET meta` lists as `watchers` for a view of `apps` (`null`: every app). `undefined` outside
   * a control plane (this process's own list stands). On a control plane the union of what the
   * instances of those apps report (plus this process's own when every app is in view), or `null`
   * (unknown) when the fleet is off or an app in view runs a version that does not report them.
   */
  consoleWatchers(apps: readonly string[] | null): Promise<string[] | null | undefined> {
    const registry = this.registry;
    return consoleWatchers({
      controlPlane: this.kind === 'control-plane',
      instances: registry === null ? null : (scope) => registry.instances(scope),
      apps,
      selfApp: this.selfApp,
      // Instances gone longer than the retention left no entry on screen.
      since: Date.now() - (this.core.prune?.afterMs ?? 86_400_000),
      own: () => this.service.enabledWatchers(),
    });
  }

  /** The fleet as a viewer limited to `scope` sees it; `store` is the (scoped) entries store. */
  read(scope: FleetScope, store: StorageProvider | null): Promise<FleetView> {
    const self = this.selfApp;
    return readFleet(scope, {
      fleet: this.registry,
      reporter: this.reporter,
      selfChecks: () => this.checks.states(),
      store,
      // A tenant's entries carry `app:<id>`; this app's own entries carry none.
      tagByApp: (app) => this.kind === 'control-plane' && app !== self,
    });
  }

  /** The readiness probe: not ready while a critical check is down or the instance drains. */
  async readiness(): Promise<ReadinessReport> {
    const report = await this.checks.report();
    const state = this.draining ? 'draining' : (this.reporter?.currentState ?? 'ready');
    return {
      ...report,
      ready: report.status !== 'down' && !this.draining,
      state,
      role: this.reporter?.role ?? this.config.role ?? WEB_ROLE,
    };
  }

  /** The last known states of this process's checks, without running them. */
  states(): CheckState[] {
    return this.checks.states();
  }
}

/** A tenant store's counters as a heartbeat carries them. */
function shippingOf(stats: ShippingStats): HeartbeatShipping {
  return {
    buffered: stats.buffered,
    dropped: stats.dropped,
    sent: stats.sent,
    failures: stats.consecutiveFailures,
    lagMs: stats.lagMs,
    lastError: stats.lastError,
  };
}
