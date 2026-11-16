// packages/core/src/topology/ingest.controller.ts
//
// `POST <path>/api/ingest`: where tenant apps send their entries over HTTP. Mounted on every app
// (which controllers exist is fixed before async options resolve) and a 404 unless
// `topology: 'control-plane'`. It is not behind the console's `authorize` or `decorators`: the
// tenant's token is its credential.
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Post,
} from '@nestjs/common';
import {
  TELESCOPE_OPTIONS,
  TELESCOPE_STORAGE,
  type TelescopeModuleOptions,
} from '../nest/telescope.options.js';
import { TelescopeService } from '../nest/telescope.service.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { resolveTopology } from './config.js';
import { type IngestHandler, createIngestHandler, ingestHttpStatus } from './ingest.js';

/** The bearer token of an `Authorization` header. */
export function bearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

@Controller('telescope/api/ingest')
export class TelescopeIngestController {
  private readonly logger = new Logger('TelescopeIngest');
  private handler: IngestHandler | null | undefined;

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TelescopeService) private readonly service: TelescopeService,
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
  ) {}

  /** The ids among `ids` the store already holds. */
  private async existing(ids: string[]): Promise<Set<string>> {
    const page = await this.storage.get({ ids, omitContent: true, limit: ids.length });
    return new Set(page.data.map((entry) => entry.id));
  }

  /** The control plane's handler; `null` on any other topology. */
  private ingest(): IngestHandler | null {
    if (this.handler !== undefined) return this.handler;
    const topology = resolveTopology(this.options);
    this.handler =
      topology.kind === 'control-plane'
        ? createIngestHandler({
            verifyTenant: topology.verifyTenant,
            store: (entries) => this.service.storeIngested(entries),
            existing: (ids) => this.existing(ids),
          })
        : null;
    return this.handler;
  }

  @Post()
  @HttpCode(202)
  async receive(
    @Body() body: unknown,
    @Headers('authorization') authorization: unknown,
  ): Promise<{ stored: number; duplicate: number }> {
    const handler = this.ingest();
    if (handler === null) throw new NotFoundException();
    const outcome = await handler({ token: bearerToken(authorization), body });
    if (outcome.status === 'stored') {
      return { stored: outcome.stored, duplicate: outcome.duplicate };
    }
    if ('reason' in outcome) this.logger.warn(`refused a batch: ${outcome.reason}`);
    throw new HttpException({ error: outcome.status }, ingestHttpStatus(outcome));
  }
}
