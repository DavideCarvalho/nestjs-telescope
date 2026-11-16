// packages/core/src/topology/ingest.service.ts
//
// The control plane's one ingest handler, shared by the HTTP route and a broker consumer, so a
// batch redelivered through either is deduped once (a fleet can mix HTTP and broker tenants).
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  TELESCOPE_OPTIONS,
  TELESCOPE_STORAGE,
  type TelescopeModuleOptions,
} from '../nest/telescope.options.js';
import { TelescopeService } from '../nest/telescope.service.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { type ResolvedTopology, resolveTopology } from './config.js';
import { type IngestHandler, createIngestHandler } from './ingest.js';
import type { TransportListener } from './transport.js';

@Injectable()
export class TelescopeIngest implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('TelescopeIngest');
  private readonly topology: ResolvedTopology;
  /** The handler on a control plane; `null` on any other topology. */
  readonly handler: IngestHandler | null;
  private listener: TransportListener | undefined;

  constructor(
    @Inject(TELESCOPE_OPTIONS) options: TelescopeModuleOptions,
    @Inject(TelescopeService) private readonly service: TelescopeService,
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
  ) {
    this.topology = resolveTopology(options);
    this.handler =
      this.topology.kind === 'control-plane'
        ? createIngestHandler({
            verifyTenant: this.topology.verifyTenant,
            store: (entries) => this.service.storeIngested(entries),
            existing: (ids) => this.existing(ids),
          })
        : null;
  }

  /** The ids among `ids` the store already holds. */
  private async existing(ids: string[]): Promise<Set<string>> {
    const page = await this.storage.get({ ids, omitContent: true, limit: ids.length });
    return new Set(page.data.map((entry) => entry.id));
  }

  /** Starts the broker consumer (a control plane with `transport`), after the store is ready. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.topology.kind !== 'control-plane' || this.handler === null) return;
    const transport = this.topology.transport;
    if (transport?.listen === undefined) return;
    this.listener = await transport.listen(this.handler, this.logger);
    this.logger.log(`consuming tenant batches from ${transport.kind}`);
  }

  /** Stops consuming before the service's final flush and the store's close. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.listener?.stop();
    this.listener = undefined;
    if (this.topology.kind === 'control-plane') await this.topology.transport?.close?.();
  }
}
