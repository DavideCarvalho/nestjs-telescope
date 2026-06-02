// packages/core/src/nest/telescope.controller.ts
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { durationToMs } from '../config/parse-duration.js';
import type { Entry } from '../entry/entry.js';
import { type QueueMetricsResult, QueueMetricsService } from '../metrics/queue-metrics.service.js';
import { type PulseResult, PulseService } from '../pulse/pulse.service.js';
import type {
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
} from '../storage/storage-provider.js';
import { TelescopeGuard } from './telescope.guard.js';
import { TELESCOPE_STORAGE } from './telescope.options.js';
import { type TelescopeMeta, TelescopeService } from './telescope.service.js';

interface ListQuery {
  type?: string;
  tag?: string;
  familyHash?: string;
  batchId?: string;
  cursor?: string;
  limit?: string;
}

@UseGuards(TelescopeGuard)
@Controller('telescope/api')
export class TelescopeController {
  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Inject(TelescopeService) private readonly service: TelescopeService,
    @Inject(QueueMetricsService) private readonly queueMetrics: QueueMetricsService,
    @Inject(PulseService) private readonly pulse: PulseService,
  ) {}

  @Get('entries')
  list(@Query() query: ListQuery): Promise<Page<Entry>> {
    const entryQuery: EntryQuery = {
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.tag !== undefined ? { tag: query.tag } : {}),
      ...(query.familyHash !== undefined ? { familyHash: query.familyHash } : {}),
      ...(query.batchId !== undefined ? { batchId: query.batchId } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.limit !== undefined && Number.isFinite(Number(query.limit))
        ? { limit: Number(query.limit) }
        : {}),
    };
    return this.storage.get(entryQuery);
  }

  @Get('entries/:id')
  show(@Param('id') id: string): Promise<EntryWithBatch | null> {
    return this.storage.find(id);
  }

  @Get('batches/:id')
  batch(@Param('id') id: string): Promise<Entry[]> {
    return this.storage.batch(id);
  }

  @Get('tags')
  tags(@Query('prefix') prefix?: string): Promise<TagCount[]> {
    return this.storage.tags(prefix);
  }

  @Get('queues')
  queues(@Query('window') window?: string): Promise<QueueMetricsResult> {
    let windowMs: number;
    try {
      windowMs = durationToMs(window ?? '1h');
    } catch {
      throw new BadRequestException(`Invalid window: ${window}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new BadRequestException(`Window must be positive: ${window}`);
    }
    return this.queueMetrics.getQueueMetrics(windowMs);
  }

  @Get('pulse')
  pulseHealth(@Query('window') window?: string): Promise<PulseResult> {
    let windowMs: number;
    try {
      windowMs = durationToMs(window ?? '1h');
    } catch {
      throw new BadRequestException(`Invalid window: ${window}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new BadRequestException(`Window must be positive: ${window}`);
    }
    return this.pulse.getHealth(windowMs);
  }

  @Get('meta')
  meta(): Promise<TelescopeMeta> {
    return this.service.getMeta();
  }

  @Delete('entries')
  async clear(): Promise<{ cleared: true }> {
    await this.storage.clear();
    return { cleared: true };
  }
}
