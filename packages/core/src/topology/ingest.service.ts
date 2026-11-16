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
import type { TelescopeTransport, TransportListener } from './transport.js';

const MAX_RETRY_MS = 30_000;

@Injectable()
export class TelescopeIngest implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('TelescopeIngest');
  private readonly topology: ResolvedTopology;
  /** The handler on a control plane; `null` on any other topology. */
  readonly handler: IngestHandler | null;
  private listener: TransportListener | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

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

  /**
   * Starts the broker consumer (a control plane with `transport`), after the store is ready. Never
   * awaited by the boot: a broker that is down (or a connect that hangs) must not keep the HTTP
   * ingest route and the console from serving. A failed start is retried with backoff (up to 30 s).
   */
  onApplicationBootstrap(): void {
    if (this.topology.kind !== 'control-plane' || this.handler === null) return;
    const transport = this.topology.transport;
    if (transport?.listen === undefined) return;
    this.connect(transport, this.handler, 1_000);
  }

  private connect(transport: TelescopeTransport, handler: IngestHandler, delayMs: number): void {
    if (this.stopped || transport.listen === undefined) return;
    transport.listen(handler, this.logger).then(
      (listener) => {
        if (this.stopped) {
          void listener.stop();
          return;
        }
        this.listener = listener;
        this.logger.log(`consuming tenant batches from ${transport.kind}`);
      },
      (error: unknown) => {
        if (this.stopped) return;
        this.logger.warn(
          `cannot consume tenant batches from ${transport.kind} yet (retrying in ${Math.round(delayMs / 1000)} s; HTTP ingest is unaffected): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.retry = setTimeout(
          () => this.connect(transport, handler, Math.min(delayMs * 2, MAX_RETRY_MS)),
          delayMs,
        );
        this.retry.unref?.();
      },
    );
  }

  /** Stops consuming before the service's final flush and the store's close. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.listener?.stop();
    this.listener = undefined;
    if (this.topology.kind === 'control-plane') await this.topology.transport?.close?.();
  }
}
