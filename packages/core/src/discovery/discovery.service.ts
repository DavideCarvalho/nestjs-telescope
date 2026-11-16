// packages/core/src/discovery/discovery.service.ts
//
// Service discovery in a Nest app: `fetch('http://billing/…')` reaches the app named `billing`.
// A tenant reads the control plane's map (snapshot at boot, then a long poll); a control plane
// serves that map from its fleet and resolves names from it itself; a standalone app uses
// `discovery.apps`. Nothing is installed when there is nothing to resolve.
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ResolvedCoreConfig } from '../config/options.js';
import { TelescopeFleet } from '../fleet/fleet.service.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_OPTIONS,
  type TelescopeModuleOptions,
} from '../nest/telescope.options.js';
import { type ResolvedTopology, resolveTopology } from '../topology/config.js';
import { DiscoveryClient } from './client.js';
import { type ResolvedDiscovery, defaultSnapshotPath, resolveDiscovery } from './config.js';
import { ServiceDirectory, publishDirectory } from './directory.js';
import { type InstalledRewrite, installFetchRewrite, installNodeHttpRewrite } from './rewrite.js';
import { DiscoveryPublisher } from './server.js';

/** How often a control plane refreshes its own copy of the map (heartbeats also refresh it). */
const SELF_REFRESH_MS = 5_000;

@Injectable()
export class TelescopeDiscovery
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown, OnModuleDestroy
{
  private readonly logger = new Logger('TelescopeDiscovery');
  readonly config: ResolvedDiscovery;
  private readonly topology: ResolvedTopology;
  /** The map a control plane serves on `GET <path>/api/discovery`; `null` elsewhere. */
  publisher: DiscoveryPublisher | null = null;
  /** The map this process resolves names with, while discovery runs. */
  directory: ServiceDirectory | null = null;
  private client: DiscoveryClient | null = null;
  private rewrite: InstalledRewrite | null = null;
  private stops: Array<() => void> = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_CONFIG) private readonly core: ResolvedCoreConfig,
    @Inject(TelescopeFleet) private readonly fleet: TelescopeFleet,
  ) {
    this.config = resolveDiscovery(options.discovery);
    this.topology = resolveTopology(options);
  }

  /** The control plane's telescope URL a tenant reads the map from, or `null`. */
  private tenantUrl(): string | null {
    if (this.topology.kind !== 'tenant') return null;
    if (this.config.serverUrl !== null) return this.config.serverUrl;
    const url = this.topology.options.url;
    return this.topology.transport.kind === 'http' && typeof url === 'string' && url.trim() !== ''
      ? url.trim()
      : null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.core.enabled || !this.config.enabled) return;
    const registry = this.fleet.registry;
    if (this.topology.kind === 'control-plane' && registry !== null) {
      const publisher = new DiscoveryPublisher({
        instances: () => registry.instances(),
        derive: registry.deriveOptions,
      });
      this.publisher = publisher;
      this.stops.push(registry.onBeat(() => publisher.poke()));
    }
    const tenantUrl = this.tenantUrl();
    if (
      Object.keys(this.config.apps).length === 0 &&
      tenantUrl === null &&
      this.publisher === null
    ) {
      return;
    }
    const directory = new ServiceDirectory(this.config.apps, { failFast: this.config.failFast });
    this.directory = directory;
    if (tenantUrl !== null && this.topology.kind === 'tenant') {
      this.client = new DiscoveryClient({
        url: tenantUrl,
        token: this.topology.token,
        partition: this.topology.partition,
        directory,
        snapshotPath: this.config.snapshotPath ?? defaultSnapshotPath(this.topology.partition),
        onError: (message) => this.logger.warn(`discovery: ${message}`),
      });
      this.client.start();
    }
    if (this.publisher !== null && registry !== null) {
      // A control plane resolves names from its own fleet.
      const publisher = this.publisher;
      const refresh = () => {
        publisher
          .current('*')
          .then((map) => directory.update(map))
          .catch(() => undefined);
      };
      refresh();
      this.stops.push(registry.onBeat(refresh));
      this.refreshTimer = setInterval(refresh, SELF_REFRESH_MS);
      this.refreshTimer.unref?.();
    }
    this.stops.push(publishDirectory(directory));
    const rewriteOptions = {
      passthrough: this.config.passthrough,
      failFast: this.config.failFast,
      strict: this.config.strict,
    };
    this.rewrite = await installFetchRewrite(directory, rewriteOptions);
    if (this.rewrite === null) {
      this.logger.warn(
        "discovery: the global fetch dispatcher cannot be composed onto; fetch('http://<app>/…') is not resolved.",
      );
    }
    if (this.config.nodeHttp) this.stops.push(installNodeHttpRewrite(directory, rewriteOptions));
  }

  /**
   * The app is up: put the rewrite back on top of the global dispatcher (a library may have
   * composed onto it during boot), then check that `fetch` really goes through it.
   */
  async onApplicationBootstrap(): Promise<void> {
    const rewrite = this.rewrite;
    if (rewrite === null) return;
    rewrite.reassert();
    if (!(await rewrite.selfCheck())) {
      throw new Error(
        "telescope discovery: fetch does not go through telescope's rewrite. Something replaced Node's global dispatcher instead of composing onto it (setGlobalDispatcher(new Agent(...))), so fetch('http://billing/…') would not reach the app. Compose onto the existing dispatcher instead, or set `discovery: false`.",
      );
    }
  }

  /** Answer the held discovery requests before the server stops. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.publisher?.close();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    await this.client?.stop();
    this.client = null;
    this.rewrite?.uninstall();
    this.rewrite = null;
    for (const stop of this.stops.splice(0)) stop();
    this.directory = null;
  }
}
