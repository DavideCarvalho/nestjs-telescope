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
} from '@nestjs/common';
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
import { type HeartbeatShipping, normalizeHeartbeat } from './heartbeat.js';
import { FleetRegistry, InstanceReporter } from './registry.js';
import { MemoryFleetStore } from './store.js';
import { type FleetScope, type FleetView, readFleet } from './view.js';

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

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_CONFIG) private readonly core: ResolvedCoreConfig,
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Inject(TelescopeService) private readonly service: TelescopeService,
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
    this.reporter = new InstanceReporter({
      intervalMs: this.config.intervalMs,
      host: this.config.host,
      version: () => resolveVersion(this.config.version),
      checks: this.checks.size > 0 ? this.checks : null,
      shipping: tenantStore ? () => shippingOf(tenantStore.stats()) : () => null,
      url: this.config.url,
      send: (heartbeat) => {
        if (tenantStore) tenantStore.setHeartbeat(heartbeat);
        else if (this.registry && this.selfApp) return this.registry.beat(this.selfApp, heartbeat);
      },
      onError: (error) =>
        this.logger.warn(`heartbeat: ${error instanceof Error ? error.message : String(error)}`),
    });
    this.registry?.startPruning();
    this.service.setFleetSource(this.registry);
    this.reporter.start();
  }

  /** The app has booted: `ready`. */
  async onApplicationBootstrap(): Promise<void> {
    await this.reporter?.setState('ready');
  }

  /** Shutdown began: `draining` (readiness answers 503), sent before the final flush. */
  async beforeApplicationShutdown(): Promise<void> {
    this.draining = true;
    await this.reporter?.setState('draining');
    this.reporter?.stop();
  }

  onModuleDestroy(): void {
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
      const serving = app.counts.up + app.counts.starting;
      const known = serving + app.counts.draining + app.counts.gone;
      states.push({
        name: 'instances',
        app: app.app,
        status: serving > 0 ? 'ok' : 'down',
        // The same count as the status: an instance still starting is serving (a deploy).
        message: `${serving} of ${known} instance${known === 1 ? '' : 's'} up or starting`,
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
    return { ...report, ready: report.status !== 'down' && !this.draining, state };
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
