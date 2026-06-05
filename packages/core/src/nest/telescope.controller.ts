// packages/core/src/nest/telescope.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  MethodNotAllowedException,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { durationToMs } from '../config/parse-duration.js';
import type { QueryContent } from '../entry/content.js';
import { type Entry, EntryType } from '../entry/entry.js';
import { type QueueMetricsResult, QueueMetricsService } from '../metrics/queue-metrics.service.js';
import { type ServerStats, ServerStatsService } from '../metrics/server-stats.service.js';
import type { StatsResult } from '../metrics/stats.js';
import { StatsService } from '../metrics/stats.service.js';
import { type TimeseriesResult, TimeseriesService } from '../metrics/timeseries.service.js';
import { type TracesResult, TracesService } from '../metrics/traces.service.js';
import { type PulseResult, PulseService } from '../pulse/pulse.service.js';
import {
  type JobPage,
  QUEUE_ACTIONS,
  type QueueActionName,
  type QueueCounts,
  type QueueJobDetail,
  type QueueManager,
  type QueueSummary,
  isQueueState,
} from '../queue/queue-manager.js';
import { QueueManagerRegistry } from '../queue/queue-manager.registry.js';
import type { ScheduledTask } from '../schedule/schedule-manager.js';
import { ScheduleManagerRegistry } from '../schedule/schedule-manager.registry.js';
import type {
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
} from '../storage/storage-provider.js';
import { TelescopeActionGuard } from './telescope-action.guard.js';
import { TelescopeGuard } from './telescope.guard.js';
import { TELESCOPE_OPTIONS, TELESCOPE_STORAGE } from './telescope.options.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { type TelescopeHealth, type TelescopeMeta, TelescopeService } from './telescope.service.js';

interface ListQuery {
  type?: string;
  tag?: string;
  familyHash?: string;
  batchId?: string;
  traceId?: string;
  search?: string;
  cursor?: string;
  limit?: string;
}

export interface QueueCapabilities {
  mutationsEnabled: boolean;
  actionsByDriver: Record<string, QueueActionName[]>;
}

/** Maps a queue action to the optional QueueManager method that implements it. */
const ACTION_METHOD: Record<QueueActionName, keyof QueueManager> = {
  retry: 'retry',
  remove: 'remove',
  promote: 'promote',
  'retry-all': 'retryAll',
  redrive: 'redrive',
  enqueue: 'enqueue',
};

interface EnqueueBody {
  name?: string;
  payload?: unknown;
}

interface ExplainBody {
  entryId?: string;
}

/**
 * Retention/prune status surfaced to the dashboard. `retention` mirrors meta's
 * shape (the configured window) or `null` when unbounded. `entryCount`/
 * `oldestCreatedAt` are `null` unless the storage SPI can expose them cheaply
 * (it currently can't — newest-first `get` has no count/oldest), so we never
 * scan to derive them. `pruneSupported` advertises that the on-demand prune
 * endpoint exists (separate from whether it's authorized/configured).
 */
export interface RetentionInfo {
  retention: { afterMs: number; keepLast: number | null } | null;
  entryCount: number | null;
  oldestCreatedAt: string | null;
  pruneSupported: true;
}

/** Type guard: a query entry carries a non-empty SQL string to explain. */
function isQueryContentWithSql(content: unknown): content is QueryContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    'sql' in content &&
    typeof (content as { sql: unknown }).sql === 'string' &&
    (content as { sql: string }).sql !== ''
  );
}

@UseGuards(TelescopeGuard)
@Controller('telescope/api')
export class TelescopeController {
  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Inject(TelescopeService) private readonly service: TelescopeService,
    @Inject(QueueMetricsService) private readonly queueMetrics: QueueMetricsService,
    @Inject(TimeseriesService) private readonly timeseriesService: TimeseriesService,
    @Inject(TracesService) private readonly tracesService: TracesService,
    @Inject(StatsService) private readonly statsService: StatsService,
    @Inject(ServerStatsService) private readonly serverStats: ServerStatsService,
    @Inject(PulseService) private readonly pulse: PulseService,
    @Inject(QueueManagerRegistry) private readonly queueManagers: QueueManagerRegistry,
    @Inject(ScheduleManagerRegistry) private readonly scheduleManagers: ScheduleManagerRegistry,
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
  ) {}

  @Get('entries')
  list(@Query() query: ListQuery): Promise<Page<Entry>> {
    const entryQuery: EntryQuery = {
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.tag !== undefined ? { tag: query.tag } : {}),
      ...(query.familyHash !== undefined ? { familyHash: query.familyHash } : {}),
      ...(query.batchId !== undefined ? { batchId: query.batchId } : {}),
      ...(query.traceId !== undefined ? { traceId: query.traceId } : {}),
      ...(query.search !== undefined && query.search !== '' ? { search: query.search } : {}),
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

  @Get('timeseries')
  timeseries(
    @Query('window') window?: string,
    @Query('buckets') buckets?: string,
    @Query('type') type?: string,
    @Query('tag') tag?: string,
  ): Promise<TimeseriesResult> {
    let windowMs: number;
    try {
      windowMs = durationToMs(window ?? '1h');
    } catch {
      throw new BadRequestException(`Invalid window: ${window}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new BadRequestException(`Window must be positive: ${window}`);
    }
    const bucketCount = buckets !== undefined ? Number(buckets) : undefined;
    return this.timeseriesService.getTimeseries({
      windowMs,
      ...(bucketCount !== undefined && Number.isFinite(bucketCount)
        ? { buckets: bucketCount }
        : {}),
      ...(type !== undefined ? { type } : {}),
      ...(tag !== undefined ? { tag } : {}),
    });
  }

  @Get('traces')
  traces(@Query('window') window?: string, @Query('limit') limit?: string): Promise<TracesResult> {
    let windowMs: number;
    try {
      windowMs = durationToMs(window ?? '1h');
    } catch {
      throw new BadRequestException(`Invalid window: ${window}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new BadRequestException(`Window must be positive: ${window}`);
    }
    const limitCount = limit !== undefined ? Number(limit) : undefined;
    return this.tracesService.getTraces({
      windowMs,
      ...(limitCount !== undefined && Number.isFinite(limitCount) ? { limit: limitCount } : {}),
    });
  }

  @Get('stats')
  stats(
    @Query('type') type?: string,
    @Query('window') window?: string,
    @Query('buckets') buckets?: string,
  ): Promise<StatsResult> {
    if (type === undefined || type === '') {
      throw new BadRequestException('Query parameter "type" is required.');
    }
    let windowMs: number;
    try {
      windowMs = durationToMs(window ?? '1h');
    } catch {
      throw new BadRequestException(`Invalid window: ${window}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new BadRequestException(`Window must be positive: ${window}`);
    }
    const bucketCount = buckets !== undefined ? Number(buckets) : undefined;
    return this.statsService.getStats({
      type,
      windowMs,
      ...(bucketCount !== undefined && Number.isFinite(bucketCount)
        ? { buckets: bucketCount }
        : {}),
    });
  }

  @Get('queues/live')
  async liveQueues(): Promise<{ queues: QueueSummary[]; capabilities: QueueCapabilities }> {
    const managers = this.queueManagers.all();
    const all = await Promise.all(managers.map((m) => m.listQueues()));
    const actionsByDriver: Record<string, QueueActionName[]> = {};
    for (const manager of managers) {
      actionsByDriver[manager.driver] = QUEUE_ACTIONS.filter(
        (action) => typeof manager[ACTION_METHOD[action]] === 'function',
      );
    }
    return {
      queues: all.flat(),
      capabilities: {
        mutationsEnabled: Boolean(this.options.authorizeAction),
        actionsByDriver,
      },
    };
  }

  @Get('schedules/live')
  async liveSchedules(): Promise<{ tasks: ScheduledTask[] }> {
    const ctx = this.scheduleManagers.context();
    const all = await Promise.all(this.scheduleManagers.all().map((m) => m.listTasks(ctx)));
    return { tasks: all.flat() };
  }

  @Get('queues/live/:driver/:queue/counts')
  liveCounts(@Param('driver') driver: string, @Param('queue') queue: string): Promise<QueueCounts> {
    return this.requireManager(driver).counts(queue);
  }

  @Get('queues/live/:driver/:queue/jobs')
  liveJobs(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Query('state') state?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<JobPage> {
    if (!isQueueState(state)) throw new BadRequestException(`Invalid state: ${state}`);
    const page = {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined && Number.isFinite(Number(limit)) ? { limit: Number(limit) } : {}),
    };
    return this.requireManager(driver).listJobs(queue, state, page);
  }

  @Get('queues/live/:driver/:queue/jobs/:id')
  liveJob(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Param('id') id: string,
  ): Promise<QueueJobDetail | null> {
    return this.requireManager(driver).getJob(queue, id);
  }

  @Post('queues/live/:driver/:queue/jobs/:id/:action')
  @HttpCode(200)
  @UseGuards(TelescopeActionGuard)
  async jobAction(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Param('id') id: string,
    @Param('action') action: string,
  ): Promise<{ ok: true }> {
    const manager = this.requireManager(driver);
    if (action === 'retry') {
      await this.callAction(manager.retry, manager, queue, id, action);
    } else if (action === 'remove') {
      await this.callAction(manager.remove, manager, queue, id, action);
    } else if (action === 'promote') {
      await this.callAction(manager.promote, manager, queue, id, action);
    } else throw new BadRequestException(`Invalid job action: ${action}`);
    return { ok: true };
  }

  @Post('queues/live/:driver/:queue/actions/:action')
  @HttpCode(200)
  @UseGuards(TelescopeActionGuard)
  async queueAction(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Param('action') action: string,
    @Query('state') state?: string,
  ): Promise<{ ok: true; count?: number }> {
    const manager = this.requireManager(driver);
    if (action === 'retry-all') {
      if (!isQueueState(state)) throw new BadRequestException(`Invalid state: ${state}`);
      if (!manager.retryAll)
        throw new MethodNotAllowedException(`Driver ${driver} cannot retry-all`);
      return { ok: true, count: await manager.retryAll(queue, state) };
    }
    if (action === 'redrive') {
      if (!manager.redrive) throw new MethodNotAllowedException(`Driver ${driver} cannot redrive`);
      return { ok: true, count: await manager.redrive(queue) };
    }
    throw new BadRequestException(`Invalid queue action: ${action}`);
  }

  // Enqueue carries a JSON body (name + payload), so it lives on its own route
  // rather than under `:action`. Still gated by the same default-deny guard.
  @Post('queues/live/:driver/:queue/enqueue')
  @HttpCode(200)
  @UseGuards(TelescopeActionGuard)
  async enqueue(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Body() body: EnqueueBody,
  ): Promise<{ id: string | null }> {
    if (body === undefined || body === null || !('payload' in body)) {
      throw new BadRequestException('Body must include a "payload".');
    }
    const manager = this.requireManager(driver);
    if (!manager.enqueue) throw new NotFoundException(`Driver ${driver} cannot enqueue`);
    const opts = body.name !== undefined ? { name: body.name } : {};
    return manager.enqueue(queue, body.payload, opts, this.queueManagers.context());
  }

  private async callAction(
    fn: ((queue: string, id: string) => Promise<void>) | undefined,
    manager: QueueManager,
    queue: string,
    id: string,
    action: string,
  ): Promise<void> {
    if (!fn) throw new MethodNotAllowedException(`Driver ${manager.driver} cannot ${action}`);
    await fn.call(manager, queue, id);
  }

  private requireManager(driver: string): QueueManager {
    const manager = this.queueManagers.get(driver);
    if (!manager) throw new NotFoundException(`Unknown queue driver: ${driver}`);
    return manager;
  }

  @Get('meta')
  meta(): Promise<TelescopeMeta> {
    return this.service.getMeta();
  }

  @Get('server-stats')
  serverStatsSnapshot(): ServerStats {
    return this.serverStats.getStats();
  }

  @Get('health')
  health(): TelescopeHealth {
    return this.service.getHealth();
  }

  // ── Retention / prune ──────────────────────────────────────────────────────

  @Get('retention')
  retention(): RetentionInfo {
    const prune = this.options.prune;
    // entryCount / oldestCreatedAt require an ascending scan or a count the
    // StorageProvider SPI does not expose cheaply. We deliberately do NOT scan,
    // so both stay null until/unless the SPI grows a cheap accessor.
    return {
      retention: prune
        ? {
            afterMs: durationToMs(prune.after),
            keepLast: prune.keepLast ?? null,
          }
        : null,
      entryCount: null,
      oldestCreatedAt: null,
      pruneSupported: true,
    };
  }

  // Prune is a MUTATION (deletes entries), so it stays behind the default-deny
  // authorizeAction gate. The queue-shaped TelescopeActionGuard can't validate
  // it (no driver/queue/action params), so we enforce the same default-deny
  // here directly: no `authorizeAction` configured → 403.
  @Post('retention/prune')
  @HttpCode(200)
  async prune(): Promise<{ pruned: number }> {
    if (!this.options.authorizeAction) {
      throw new ForbiddenException('Mutations are disabled (no authorizeAction configured).');
    }
    const prune = this.options.prune;
    if (!prune) {
      throw new BadRequestException('No `prune` retention window is configured.');
    }
    const olderThan = new Date(Date.now() - durationToMs(prune.after));
    const pruned =
      prune.keepLast !== undefined
        ? await this.storage.prune(olderThan, prune.keepLast)
        : await this.storage.prune(olderThan);
    return { pruned };
  }

  // ── Query EXPLAIN ──────────────────────────────────────────────────────────

  // Read-shaped (it returns a plan, mutates no Telescope state) so it sits behind
  // the normal read guard. NOTE: the host hook runs arbitrary `EXPLAIN <sql>`
  // against its database — hosts MUST scope that connection read-only.
  @Post('queries/explain')
  @HttpCode(200)
  async explain(@Body() body: ExplainBody): Promise<{ plan: unknown }> {
    const explainQuery = this.options.explainQuery;
    if (!explainQuery) {
      throw new NotFoundException('Query EXPLAIN is not configured.');
    }
    if (body === undefined || body === null || typeof body.entryId !== 'string') {
      throw new BadRequestException('Body must include an "entryId".');
    }
    const entry = await this.storage.find(body.entryId);
    if (!entry || entry.type !== EntryType.Query || !isQueryContentWithSql(entry.content)) {
      throw new NotFoundException('No query entry with SQL for that id.');
    }
    try {
      // Pass the SQL/bindings EXACTLY as captured — plans carry no user data.
      const plan = await explainQuery(entry.content.sql, entry.content.bindings ?? []);
      return { plan };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'EXPLAIN failed.';
      throw new ServiceUnavailableException({ message });
    }
  }

  @Delete('entries')
  async clear(): Promise<{ cleared: true }> {
    await this.storage.clear();
    return { cleared: true };
  }
}
