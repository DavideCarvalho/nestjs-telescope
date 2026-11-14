// packages/core/src/nest/telescope.controller.ts
import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  MethodNotAllowedException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { type AiUsageResult, AiUsageService } from '../agent-metrics/ai-usage.service.js';
import type { ResolvedCoreConfig } from '../config/options.js';
import { durationToMs } from '../config/parse-duration.js';
import { CONTEXT_ACCESSOR } from '../context/context-accessor.js';
import { tenantLabels, tenantTagPrefix } from '../context/tenancy.js';
import type { QueryContent, RequestContent } from '../entry/content.js';
import { type Entry, EntryType } from '../entry/entry.js';
import { ExtensionRegistry } from '../extension/registry.js';
import type { ExtensionActionCaller, Panel } from '../extension/types.js';
import { collectEntriesInWindow } from '../metrics/collect-window.js';
import { type QueueMetricsResult, QueueMetricsService } from '../metrics/queue-metrics.service.js';
import {
  type ServerStats,
  type ServerStatsHistory,
  ServerStatsService,
} from '../metrics/server-stats.service.js';
import type { StatsResult } from '../metrics/stats.js';
import { StatsService } from '../metrics/stats.service.js';
import { type TimeseriesResult, TimeseriesService } from '../metrics/timeseries.service.js';
import { type TracesResult, TracesService } from '../metrics/traces.service.js';
import type { Waterfall } from '../metrics/waterfall.js';
import { CPU_PROFILE_ENTRY_TYPE, ProfilerService } from '../profiling/profiler.service.js';
import type { CpuProfileContent } from '../profiling/types.js';
import { type PulseResult, PulseService } from '../pulse/pulse.service.js';
import {
  QUEUE_ACTIONS,
  type QueueActionName,
  type QueueCounts,
  type QueueJob,
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
  StorageProvider,
  TagCount,
} from '../storage/storage-provider.js';
import { activeTenantView, withoutTenantView } from '../storage/tenant-scoped-storage.js';
import type { ConsoleTenancyInfo } from './console-tenant-scope.js';
import { consoleTenantCallOf } from './console-tenant.interceptor.js';
import { auditExtensionAction, consoleCallerOf } from './extension-audit.js';
import { createExtensionContext } from './extension-context.factory.js';
import {
  type CursorPageResponse,
  cursorPage,
  parseCursorParams,
  parseFilterParams,
} from './list-api.js';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  forwardOnly,
  fromProviderResult,
  readSize,
  rejectRemovedParams,
  storagePage,
  tableColumnsOf,
  toProviderQuery,
} from './list-wire.js';
import { type ReplayResult, replayRequest } from './request-replay.js';
import { type PruneRun, TelescopePruner } from './telescope-pruner.service.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_EXTENSIONS,
  TELESCOPE_OPTIONS,
  TELESCOPE_STORAGE,
} from './telescope.options.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { type TelescopeHealth, type TelescopeMeta, TelescopeService } from './telescope.service.js';

/** Entries per page of `GET entries`: the default, and the cap (a trace's waterfall reads 500). */
const ENTRY_PAGE = { defaultSize: 50, maxSize: 500 } as const;

/** The `filter[...]` fields of `GET entries`, each an exact match. */
const ENTRY_FILTERS = {
  type: ['eq'],
  tag: ['eq'],
  familyHash: ['eq'],
  batchId: ['eq'],
  traceId: ['eq'],
} as const;

/** Parameters `GET entries` dropped for the list API, with what replaced them. */
const REMOVED_ENTRY_PARAMS: Record<string, string> = {
  type: '"filter[type]"',
  tag: '"filter[tag]"',
  familyHash: '"filter[familyHash]"',
  batchId: '"filter[batchId]"',
  traceId: '"filter[traceId]"',
  cursor: '"after"',
  limit: '"first"',
};

/** A page of entries: the cursor envelope, plus `partial` when a tiered store read only part. */
export type EntriesPage = CursorPageResponse<Entry> & { partial?: true };

/** CPU profiles per page of `GET profiles`. */
const PROFILE_PAGE = { defaultSize: 50, maxSize: 200 } as const;

/** Jobs per page of `GET queues/live/:driver/:queue/jobs`. */
const JOB_PAGE = { defaultSize: 50, maxSize: 200 } as const;

/** `GET traces`: the summaries in `data`, with the scan's side data next to it. */
export interface TracesList {
  data: TracesResult['traces'];
  scanned: number;
  truncated: boolean;
}

export interface QueueCapabilities {
  mutationsEnabled: boolean;
  actionsByDriver: Record<string, QueueActionName[]>;
}

/** Maps a queue action to the optional QueueManager method that implements it. */
const ACTION_METHOD = {
  retry: 'retry',
  remove: 'remove',
  promote: 'promote',
  'retry-all': 'retryAll',
  redrive: 'redrive',
  enqueue: 'enqueue',
} as const satisfies Record<QueueActionName, keyof QueueManager>;

/**
 * The per-job actions (those whose QueueManager method has the
 * `(queue, id) => Promise<void>` shape). `jobAction` dispatches via
 * {@link ACTION_METHOD}, so this subset is the route's allow-list.
 */
const JOB_ACTIONS = ['retry', 'remove', 'promote'] as const satisfies readonly QueueActionName[];
type JobAction = (typeof JOB_ACTIONS)[number];
const isJobAction = (action: string): action is JobAction =>
  (JOB_ACTIONS as readonly string[]).includes(action);

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

/** Resolved retention config surfaced to the Prunes screen. `null` when unset. */
export interface PrunesConfig {
  afterMs: number;
  intervalMs: number;
  keepLast: number | null;
  /** Per-type retention overrides (ms), omitted when none are configured. */
  perType?: Record<string, number>;
}

/**
 * Prune-run activity for the dashboard's Prunes screen: the in-memory ring of
 * recent cycles (newest-first, PER-POD), the resolved retention config, and the
 * predicted next scheduled run (`null` when no `prune` window is configured).
 */
export interface PrunesInfo {
  runs: PruneRun[];
  config: PrunesConfig | null;
  nextRunAt: string | null;
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

/**
 * Parse the `window` query param (default `1h`) into milliseconds, or throw 400.
 * Shared by every windowed metrics route (queues/pulse/timeseries/traces/stats).
 */
function parseWindowMs(window: string | undefined): number {
  let windowMs: number;
  try {
    windowMs = durationToMs(window ?? '1h');
  } catch {
    throw new BadRequestException(`Invalid window: ${window}`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new BadRequestException(`Window must be positive: ${window}`);
  }
  return windowMs;
}

/** Organizations the header's picker lists per search. */
const TENANT_OPTIONS = 50;

/** Organizations labelled per call to the context's label resolver. */
const LABEL_CHUNK = 200;

/** Organizations of a granted list a picker search labels at most (and so finds by label). */
const MAX_LABEL_SCAN = 2_000;

/** Tags per page when a caller names no size — a picker's list, not a listing. */
const TAG_PAGE = { defaultSize: 50, maxSize: 200 } as const;

/** A non-negative integer from the query string, or `undefined` for anything else. A junk bound is
 *  treated as absent rather than coerced to 0, which would return an empty page and read as "there
 *  are no tags". */
function boundedCount(raw?: string): number | undefined {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 0 ? n : undefined;
}

interface ExtensionActionBody {
  confirmed?: unknown;
  input?: unknown;
}

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
    @Inject(ProfilerService) private readonly profiler: ProfilerService,
    @Inject(QueueManagerRegistry) private readonly queueManagers: QueueManagerRegistry,
    @Inject(ScheduleManagerRegistry) private readonly scheduleManagers: ScheduleManagerRegistry,
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_EXTENSIONS) private readonly extensions: ExtensionRegistry,
    @Inject(TELESCOPE_CONFIG) private readonly extConfig: ResolvedCoreConfig,
    @Inject(TelescopePruner) private readonly pruner: TelescopePruner,
    @Inject(AiUsageService) private readonly aiUsage: AiUsageService,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  /** The context accessor when `@dudousxd/nestjs-context` provides one (else the global slot is read). */
  private get contextAccessor(): unknown {
    try {
      return this.moduleRef.get(CONTEXT_ACCESSOR, { strict: false });
    } catch {
      return undefined;
    }
  }

  /**
   * Entries, newest first, as a cursor list: `filter[type|tag|familyHash|batchId|traceId]=v`,
   * `search`, `after` (the previous page's `meta.nextCursor`) and `first` (default 50, max 500).
   * The store pages forward only. Its cursors are opaque and provider-made, so an undecodable one
   * starts from the first page, as the storage contract says.
   */
  @Get('entries')
  async list(@Query() query: Record<string, unknown>): Promise<EntriesPage> {
    rejectRemovedParams(query, REMOVED_ENTRY_PARAMS);
    forwardOnly(query);
    const filters = parseFilterParams(query, { fields: ENTRY_FILTERS });
    const { after, size } = parseCursorParams(query, ENTRY_PAGE);
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const entryQuery: EntryQuery = {
      ...Object.fromEntries(filters.map((filter) => [filter.field, filter.value as string])),
      ...(search !== '' ? { search } : {}),
      ...(after !== undefined ? { cursor: after } : {}),
      limit: size,
    };
    return storagePage(await this.storage.get(entryQuery));
  }

  @Get('entries/:id')
  show(@Param('id') id: string): Promise<EntryWithBatch | null> {
    return this.storage.find(id);
  }

  // Request REPLAY. Re-issues a captured request entry against the local server
  // and reports the outcome. It is a MUTATION (it actually hits the app, which
  // may write), so — like `prune` — it is off unless `mutations: true`.
  @Get('entries/:id/replay')
  async replay(@Param('id') id: string, @Req() request: unknown): Promise<ReplayResult> {
    this.requireMutations();
    const entry = await this.storage.find(id);
    if (entry === null || entry.type !== EntryType.Request) {
      throw new NotFoundException('No request entry with that id.');
    }
    return replayRequest(entry.content as RequestContent, request);
  }

  @Get('batches/:id')
  batch(@Param('id') id: string): Promise<Entry[]> {
    return this.storage.batch(id);
  }

  /**
   * Tag counts for a picker, most-used first (ties alphabetical), as a cursor list:
   * `filter[tag][startsWith]=user:` (the picker's fixed scope), `search` (anywhere in the tag),
   * `after` / `first` (default 50, max 200).
   *
   * Cursor, not offset paging: the store pages tags by offset in a stable order but cannot count
   * them, and the offset envelope's `total` / `lastPage` need a count. The cursor is the next
   * offset, opaque to the client; one more row than asked is read to know whether there is a next
   * page.
   *
   * The page is re-applied HERE even though the provider was asked for it, because a provider is
   * allowed to ignore the query — the contract says as much, so an older or third-party one simply
   * returns everything. Without this a picker would get more rows than it asked for, and the next
   * page would repeat them.
   */
  @Get('tags')
  async tags(@Query() query: Record<string, unknown>): Promise<CursorPageResponse<TagCount>> {
    rejectRemovedParams(query, {
      prefix: '"filter[tag][startsWith]"',
      limit: '"first"',
      offset: '"after"',
    });
    forwardOnly(query);
    const [scope] = parseFilterParams(query, { fields: { tag: ['startsWith'] } });
    const { size, decoded } = parseCursorParams(query, {
      ...TAG_PAGE,
      decode: decodeOffsetCursor,
    });
    const from = decoded ?? 0;
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const rows = await this.storage.tags(scope ? String(scope.value) : undefined, {
      ...(search !== '' ? { search } : {}),
      limit: size + 1,
      offset: from,
    });
    // A provider that ignored the query returned everything from the top.
    const window = rows.length > size + 1 ? rows.slice(from, from + size + 1) : rows;
    const hasNext = window.length > size;
    return cursorPage(window.slice(0, size), {
      nextCursor: hasNext ? encodeOffsetCursor(from + size) : null,
      prevCursor: from > 0 ? encodeOffsetCursor(Math.max(0, from - size)) : null,
    });
  }

  @Get('queues')
  queues(@Query('window') window?: string): Promise<QueueMetricsResult> {
    const windowMs = parseWindowMs(window);
    return this.queueMetrics.getQueueMetrics(windowMs);
  }

  @Get('pulse')
  pulseHealth(@Query('window') window?: string): Promise<PulseResult> {
    const windowMs = parseWindowMs(window);
    return this.pulse.getHealth(windowMs);
  }

  @Get('timeseries')
  timeseries(
    @Query('window') window?: string,
    @Query('buckets') buckets?: string,
    @Query('type') type?: string,
    @Query('tag') tag?: string,
  ): Promise<TimeseriesResult> {
    const windowMs = parseWindowMs(window);
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

  /**
   * The window's most recent traces (a top-N, not a paged list): `window`, `size` (default 50, max
   * 500). `{ data, scanned, truncated }`.
   */
  @Get('traces')
  async traces(@Query() query: Record<string, unknown>): Promise<TracesList> {
    rejectRemovedParams(query, { limit: '"size"' });
    const windowMs = parseWindowMs(typeof query.window === 'string' ? query.window : undefined);
    const size = readSize(query, { defaultSize: 50, maxSize: 500 });
    const result = await this.tracesService.getTraces({ windowMs, limit: size });
    return { data: result.traces, scanned: result.scanned, truncated: result.truncated };
  }

  // Nested span waterfall for ONE trace. Returns 404 when the trace has no
  // entries (unknown / pruned) so the dashboard can render an empty state.
  @Get('traces/:traceId/waterfall')
  async waterfall(@Param('traceId') traceId: string): Promise<Waterfall> {
    const waterfall = await this.tracesService.getWaterfall(traceId);
    if (waterfall === null) {
      throw new NotFoundException(`No entries for trace ${traceId}.`);
    }
    return waterfall;
  }

  /**
   * The AI screen: spend (by feature / model / actor, over time), agent runs with their timing
   * breakdown, and unpriced calls — summarized from the window's recorded agent entries.
   */
  @Get('ai')
  async ai(
    @Query('window') window?: string,
    @Query('buckets') buckets?: string,
    @Query('top') top?: string,
    @Query('size') size?: string,
    @Query('limit') limit?: string,
  ): Promise<AiUsageResult> {
    rejectRemovedParams({ limit }, { limit: '"size" (agent runs)' });
    const windowMs = parseWindowMs(window);
    const bucketCount = boundedCount(buckets);
    const topCount = boundedCount(top);
    const runsLimit = size === undefined ? undefined : readSize({ size }, { maxSize: 500 });
    return this.aiUsage.getUsage({
      windowMs,
      ...(bucketCount !== undefined && bucketCount > 0 ? { buckets: bucketCount } : {}),
      ...(topCount !== undefined && topCount > 0 ? { top: Math.min(topCount, 100) } : {}),
      ...(runsLimit !== undefined && runsLimit > 0 ? { runsLimit: Math.min(runsLimit, 500) } : {}),
    });
  }

  /**
   * Prometheus scrape of the AI-usage and agent-run metrics (`aviary_ai_*`, `aviary_agent_*`).
   * 404 unless `aiMetrics.prometheus` is on. Guarded like every other API route.
   */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string {
    if (!this.aiUsage.prometheusEnabled || activeTenantView() !== null) {
      throw new NotFoundException('The metrics endpoint is off (set aiMetrics.prometheus: true).');
    }
    return this.aiUsage.prometheus();
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
    const windowMs = parseWindowMs(window);
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
    // Live queues carry no tenant: one organization's view shows none of them.
    const managers = activeTenantView() === null ? this.queueManagers.all() : [];
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
        mutationsEnabled: this.options.mutations === true,
        actionsByDriver,
      },
    };
  }

  @Get('schedules/live')
  async liveSchedules(): Promise<{ tasks: ScheduledTask[] }> {
    if (activeTenantView() !== null) return { tasks: [] };
    const ctx = this.scheduleManagers.context();
    const all = await Promise.all(this.scheduleManagers.all().map((m) => m.listTasks(ctx)));
    return { tasks: all.flat() };
  }

  @Get('queues/live/:driver/:queue/counts')
  liveCounts(@Param('driver') driver: string, @Param('queue') queue: string): Promise<QueueCounts> {
    return this.requireManager(driver).counts(queue);
  }

  /**
   * One page of a live queue's jobs in one state, as a cursor list: `filter[state]` (required),
   * `after` / `first` (default 50, max 200). The drivers keep their `listJobs({ cursor, limit })`
   * SPI and its `{ jobs, nextCursor }` page; this route translates.
   */
  @Get('queues/live/:driver/:queue/jobs')
  async liveJobs(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Query() query: Record<string, unknown>,
  ): Promise<CursorPageResponse<QueueJob>> {
    rejectRemovedParams(query, {
      state: '"filter[state]"',
      cursor: '"after"',
      limit: '"first"',
    });
    forwardOnly(query);
    const [filter] = parseFilterParams(query, { fields: { state: ['eq'] } });
    const state = filter?.value;
    if (!isQueueState(state)) {
      throw new BadRequestException(`Invalid "filter[state]": ${String(state)}`);
    }
    const { after, size } = parseCursorParams(query, JOB_PAGE);
    const manager = this.requireManager(driver);
    const page = await manager.listJobs(queue, state, {
      ...(after !== undefined ? { cursor: after } : {}),
      limit: size,
    });
    return cursorPage(page.jobs, { nextCursor: page.nextCursor, prevCursor: null, hasPrev: false });
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
  async jobAction(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Param('id') id: string,
    @Param('action') action: string,
  ): Promise<{ ok: true }> {
    this.requireMutations();
    const manager = this.requireManager(driver);
    if (!isJobAction(action)) throw new BadRequestException(`Invalid job action: ${action}`);
    await this.callAction(manager[ACTION_METHOD[action]], manager, queue, id, action);
    return { ok: true };
  }

  @Post('queues/live/:driver/:queue/actions/:action')
  @HttpCode(200)
  async queueAction(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Param('action') action: string,
    @Query('state') state?: string,
  ): Promise<{ ok: true; count?: number }> {
    this.requireMutations();
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
  // rather than under `:action`. Off unless `mutations: true`, like every mutation.
  @Post('queues/live/:driver/:queue/enqueue')
  @HttpCode(200)
  async enqueue(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Body() body: EnqueueBody,
  ): Promise<{ id: string | null }> {
    this.requireMutations();
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

  /**
   * Mutations (queue actions, enqueue, prune, replay, profiling arm) are a
   * feature switched on by `mutations: true`; who may call them is decided by
   * the console's `authorize`, like every other route. Off → 403.
   */
  /** Clearing and pruning touch every organization's entries: not from one organization's view. */
  private requireAllTenants(): void {
    if (activeTenantView() !== null) {
      throw new ForbiddenException('Only a viewer of every organization can do this.');
    }
  }

  /** Every panel of every extension dashboard, sectioned or flat. */
  private *panels(): Iterable<Panel> {
    for (const dashboard of this.extensions.dashboards()) {
      yield* dashboard.panels ?? [];
      for (const section of dashboard.sections ?? []) yield* section.panels;
    }
  }

  private requireMutations(): void {
    if (this.options.mutations !== true) {
      throw new ForbiddenException('Mutations are disabled (set `mutations: true`).');
    }
  }

  private requireManager(driver: string): QueueManager {
    const manager = activeTenantView() === null ? this.queueManagers.get(driver) : undefined;
    if (!manager) throw new NotFoundException(`Unknown queue driver: ${driver}`);
    return manager;
  }

  /**
   * The header's "Organization" control: the organizations this viewer may see (tenancy on), the
   * one this view shows, and the ones to pick from, narrowed by `search`.
   */
  @Get('tenancy')
  async tenancy(
    @Req() request: unknown,
    @Query('search') search?: string,
  ): Promise<ConsoleTenancyInfo> {
    const call = consoleTenantCallOf(request);
    if (call === undefined || call.scope === null) return { enabled: false };
    const { scope, selection } = call;
    const needle = search?.trim().toLowerCase() ?? '';
    const own = scope.own;
    let ids: string[];
    if (scope.tenants === '*') {
      const prefix = `${tenantTagPrefix(this.options.tenancy)}:`;
      const rows = await withoutTenantView(() =>
        this.storage.tags(prefix, { ...(needle ? { search: needle } : {}), limit: TENANT_OPTIONS }),
      );
      ids = rows.map((row) => row.tag.slice(prefix.length)).filter((id) => id !== '' && id !== '*');
      if (own && !ids.includes(own.id)) ids.unshift(own.id);
    } else {
      ids = scope.tenants;
    }
    const kinds = typeof this.options.tenancy === 'object' ? this.options.tenancy.kinds : undefined;
    const fallbackKind = kinds?.[0] ?? own?.kind ?? 'tenant';
    const refOf = (id: string) =>
      own?.id === id
        ? { id, kind: own.kind ?? fallbackKind, ...(own.slug ? { slug: own.slug } : {}) }
        : { id, kind: fallbackKind };
    // Labelled a chunk at a time until the picker is full, so a search also finds organizations by
    // label deep in a long granted list (bounded by MAX_LABEL_SCAN).
    const options: { id: string; label: string }[] = [];
    for (
      let start = 0;
      start < Math.min(ids.length, MAX_LABEL_SCAN) && options.length < TENANT_OPTIONS;
      start += LABEL_CHUNK
    ) {
      const chunk = ids.slice(start, start + LABEL_CHUNK);
      const labels = await tenantLabels(chunk.map(refOf), this.contextAccessor);
      for (const id of chunk) {
        const label = labels[id] ?? id;
        if (!needle || `${id} ${label}`.toLowerCase().includes(needle)) options.push({ id, label });
      }
      if (!needle) break;
    }
    return {
      enabled: true,
      tenants: scope.tenants,
      // A tenant outside the scope is never echoed back: the view is empty, nothing is selected.
      selected: selection.kind === 'tenant' ? selection.id : null,
      options: options.slice(0, TENANT_OPTIONS),
    };
  }

  @Get('meta')
  meta(): Promise<TelescopeMeta> {
    return this.service.getMeta();
  }

  @Get('server-stats')
  serverStatsSnapshot(): ServerStats {
    return this.serverStats.getStats();
  }

  // CPU/mem history ring buffer for the dashboard's resource-history card.
  @Get('server-stats/history')
  serverStatsHistory(): ServerStatsHistory {
    return this.serverStats.getHistory();
  }

  @Get('health')
  health(): TelescopeHealth {
    return this.service.getHealth();
  }

  // ── Extension data providers ────────────────────────────────────────────────

  // Read-shaped: the UI calls this per panel to fetch a named provider's data.
  // 404 for an unknown provider; 502
  // when the provider throws (its message is surfaced so panel authors can see
  // why). Query params arrive as strings and are passed through verbatim.
  @Get('ext/:ext/data/:provider')
  async extData(
    @Param('ext') ext: string,
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    // Extension data carries no tenant: one organization's view shows none of it.
    const found = activeTenantView() === null ? this.extensions.findProvider(provider) : undefined;
    // The `:ext` segment must name the extension that actually owns the provider —
    // a mismatch is treated as not-found so the URL namespace can't be spoofed.
    if (!found || this.extensions.providerOwner(provider) !== ext) {
      throw new NotFoundException(`Unknown data provider "${provider}".`);
    }
    // A table panel's `page` / `size` / `sort=-col` / `filter[col]` become the provider SPI's
    // `page` / `limit` / `sort` + `dir` / `filter.<col>`, and its `{ rows, total, page, limit }`
    // the offset envelope. The SPI is unchanged, so extensions shipped elsewhere keep working.
    const { query: providerQuery, wire } = toProviderQuery(
      query,
      tableColumnsOf(this.panels(), provider),
    );
    const ctx = createExtensionContext(this.moduleRef, this.extConfig);
    try {
      return fromProviderResult(await found.resolve(providerQuery, ctx), wire);
    } catch (error) {
      throw new BadGatewayException((error as Error).message);
    }
  }

  /**
   * Runs an extension's write action (a dashboard row button). A mutation: off unless
   * `mutations: true`, behind the console's `authorize` like every route, refused from one
   * organization's view (extension data spans every organization), and only with
   * `{ confirmed: true }` in the body, which the dashboard sends after its confirmation dialog.
   * Every run, successful or not, writes an audit line with the caller.
   */
  @Post('ext/:ext/actions/:action')
  @HttpCode(200)
  async extAction(
    @Param('ext') ext: string,
    @Param('action') action: string,
    @Body() body: ExtensionActionBody | undefined,
    @Req() request: unknown,
  ): Promise<{ ok: true; result: unknown }> {
    this.requireMutations();
    this.requireAllTenants();
    const found = this.extensions.findAction(ext, action);
    if (!found) throw new NotFoundException(`Unknown extension action "${ext}.${action}".`);
    if (body?.confirmed !== true) {
      throw new BadRequestException('Confirm the action: send { "confirmed": true }.');
    }
    const input =
      typeof body.input === 'object' && body.input !== null && !Array.isArray(body.input)
        ? (body.input as Record<string, unknown>)
        : {};
    const caller: ExtensionActionCaller = { id: consoleCallerOf(request), via: 'console' };
    const ctx = { ...createExtensionContext(this.moduleRef, this.extConfig), caller };
    try {
      const result = await found.run(input, ctx);
      auditExtensionAction(ext, action, caller, input, 'ok');
      return { ok: true, result: result ?? null };
    } catch (error) {
      auditExtensionAction(ext, action, caller, input, 'failed');
      if (error instanceof HttpException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status === 'number' && status >= 400 && status < 600) {
        throw new HttpException(message, status);
      }
      throw new BadGatewayException(message);
    }
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

  // Prune-run activity / retention status for the Prunes screen. Read-shaped like
  // the other GETs. The runs come
  // from the pruner's in-memory ring (PER-POD), the config from the resolved
  // config, and nextRunAt is the pruner's predicted next scheduled cycle.
  @Get('prunes')
  prunes(): PrunesInfo {
    const prune = this.extConfig.prune;
    const nextRunAtMs = this.pruner.getNextRunAtMs();
    return {
      runs: this.pruner.getRuns(),
      config: prune
        ? {
            afterMs: prune.afterMs,
            intervalMs: prune.intervalMs,
            keepLast: prune.keepLast ?? null,
            ...(Object.keys(prune.perTypeMs).length > 0 ? { perType: prune.perTypeMs } : {}),
          }
        : null,
      nextRunAt: nextRunAtMs !== null ? new Date(nextRunAtMs).toISOString() : null,
    };
  }

  // Prune is a MUTATION (deletes entries), so it is off unless `mutations: true`
  // (403 otherwise). The cycle runs through
  // the pruner so it is recorded as a `manual` run (and honours per-type +
  // archive retention identically to the scheduled cycle).
  @Post('retention/prune')
  @HttpCode(200)
  async prune(): Promise<{ pruned: number }> {
    this.requireMutations();
    this.requireAllTenants();
    if (!this.options.prune) {
      throw new BadRequestException('No `prune` retention window is configured.');
    }
    return { pruned: await this.pruner.pruneNow() };
  }

  // ── Query EXPLAIN ──────────────────────────────────────────────────────────

  // Read-shaped (it returns a plan, mutates no Telescope state) so it is a read
  // route. NOTE: the host hook runs arbitrary `EXPLAIN <sql>`
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

  // ── AI exception diagnosis ──────────────────────────────────────────────────

  // Read-shaped ANALYSIS (it produces a markdown explanation, mutates no
  // Telescope state and runs no destructive action), so — like `explain` — it
  // is a read route, NOT behind the
  // `mutations` switch. 404 when AI isn't configured or the entry
  // isn't an exception; 502 when the diagnoser fails (a safe, generic message —
  // the model's raw error is never surfaced to the dashboard).
  @Post('exceptions/:id/diagnose')
  @HttpCode(200)
  async diagnose(
    @Param('id') id: string,
    @Query('force') force?: string,
  ): Promise<{ markdown: string; cached: boolean }> {
    const coordinator = this.service.diagnosisCoordinator;
    if (coordinator === null) {
      throw new NotFoundException('AI diagnosis is not configured.');
    }
    const entry = await this.storage.find(id);
    if (
      entry === null ||
      (entry.type !== EntryType.Exception && entry.type !== EntryType.ClientException)
    ) {
      throw new NotFoundException('No exception entry with that id.');
    }
    const occurrences = await this.countExceptionFamily(entry.type, entry.familyHash);
    try {
      return await coordinator.diagnose(entry, occurrences, force === 'true');
    } catch {
      // The diagnoser rejected (timeout / model error). Surface a generic 502;
      // the raw model error may carry provider internals, so it's never leaked.
      throw new ServiceUnavailableException({ message: 'AI diagnosis failed.' });
    }
  }

  // Read-only companion to the POST above: returns the ALREADY-cached diagnosis
  // for this entry's family, if one exists, WITHOUT ever computing a new one (no
  // model call, no token cost). The detail page fetches this on open so an
  // auto-mode (or previously on-demand) diagnosis shows immediately instead of a
  // bare "Diagnose with AI" button. Same 404 semantics as the POST:
  //   - 404 when AI isn't configured or the entry isn't an exception;
  //   - 200 `{ markdown, cached: true }` when a diagnosis is cached;
  //   - 204 (empty) when none is cached yet (the family hasn't been diagnosed).
  // The 204 — not a 200-with-null — keeps "nothing cached" unambiguous on the
  // client and never tempts a reader into treating a null body as a result.
  @Get('exceptions/:id/diagnosis')
  async cachedDiagnosis(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: unknown,
  ): Promise<{ markdown: string; cached: true } | undefined> {
    const coordinator = this.service.diagnosisCoordinator;
    if (coordinator === null) {
      throw new NotFoundException('AI diagnosis is not configured.');
    }
    const entry = await this.storage.find(id);
    if (
      entry === null ||
      (entry.type !== EntryType.Exception && entry.type !== EntryType.ClientException)
    ) {
      throw new NotFoundException('No exception entry with that id.');
    }
    const markdown = coordinator.peekCached(entry);
    if (markdown === null) {
      // No diagnosis cached for this family yet. 204 No Content — never invoke
      // the diagnoser from a GET (a read must stay free and side-effect-free).
      // `@Res` is `unknown` to keep express types out of the public signature
      // (same convention as the auth controller); narrow before setting status.
      setResponseStatus(res, 204);
      return undefined;
    }
    return { markdown, cached: true };
  }

  /** Count entries of this exception family in the trailing 24h (>= 1). */
  private async countExceptionFamily(type: string, familyHash: string | null): Promise<number> {
    if (familyHash === null) return 1;
    const after = new Date(Date.now() - durationToMs('24h'));
    const result = await collectEntriesInWindow(
      this.storage,
      { type, familyHash, after, omitContent: true },
      { scanCap: 10_000 },
    );
    return Math.max(1, result.entries.length);
  }

  // ── CPU profiling (flamegraphs) ─────────────────────────────────────────────

  /**
   * Profiler status for the dashboard's Profiles tab: whether the feature is
   * enabled, the sample rate, and current capture activity. Read-shaped. When profiling is disabled the tab shows an
   * "enable `profiling`" empty state from this payload.
   */
  @Get('profiles/status')
  profilesStatus(): ReturnType<ProfilerService['status']> {
    return this.profiler.status();
  }

  /**
   * Captured CPU profiles, newest first, WITHOUT their (potentially large) frame trees, as a
   * cursor list: `after` / `first` (default 50, max 200). `omitContent` keeps the list cheap; the
   * tree is fetched per profile via {@link profile}. Read-shaped.
   */
  @Get('profiles')
  async profiles(@Query() query: Record<string, unknown>): Promise<EntriesPage> {
    rejectRemovedParams(query, { limit: '"first"', cursor: '"after"' });
    forwardOnly(query);
    const { after, size } = parseCursorParams(query, PROFILE_PAGE);
    return storagePage(
      await this.storage.get({
        type: CPU_PROFILE_ENTRY_TYPE,
        omitContent: true,
        ...(after !== undefined ? { cursor: after } : {}),
        limit: size,
      }),
    );
  }

  /**
   * Fetch ONE profile's full frame tree (the flamegraph payload). 404 when the
   * id is unknown or not a cpu_profile entry. Read-shaped.
   */
  @Get('profiles/:id')
  async profile(@Param('id') id: string): Promise<Entry<CpuProfileContent>> {
    const entry = await this.storage.find(id);
    if (entry === null || entry.type !== CPU_PROFILE_ENTRY_TYPE) {
      throw new NotFoundException('No CPU profile with that id.');
    }
    return entry as Entry<CpuProfileContent>;
  }

  /**
   * Arm an on-demand capture of the next N requests (optionally only those whose
   * normalized route matches `label`, e.g. "GET /users/:id"). A MUTATION-shaped
   * trigger — it incurs real profiling overhead — so like prune/replay it is
   * off unless `mutations: true`. 400 when profiling is
   * disabled (so the dashboard can explain why nothing happens).
   */
  @Post('profiles/arm')
  @HttpCode(200)
  arm(@Body() body: ArmBody): { pendingManual: number } {
    this.requireMutations();
    if (!this.profiler.status().enabled) {
      throw new BadRequestException('CPU profiling is disabled (set `profiling.enabled`).');
    }
    const count = body?.count !== undefined ? Number(body.count) : 1;
    if (!Number.isFinite(count) || count <= 0) {
      throw new BadRequestException('`count` must be a positive number.');
    }
    return this.profiler.arm({
      count,
      ...(typeof body?.label === 'string' && body.label !== '' ? { label: body.label } : {}),
    });
  }

  @Delete('entries')
  async clear(): Promise<{ cleared: true }> {
    this.requireAllTenants();
    await this.storage.clear();
    return { cleared: true };
  }
}

interface ArmBody {
  count?: number;
  label?: string;
}

/**
 * Set an HTTP status on an express-like response without importing express into
 * the controller's public signatures (we type `@Res` as `unknown`, matching the
 * auth controller's convention). Narrows via a structural check rather than a
 * cast so the no-unsafe-typing rule holds; a no-op if the object lacks `.status`.
 */
function setResponseStatus(response: unknown, status: number): void {
  if (
    response !== null &&
    typeof response === 'object' &&
    'status' in response &&
    typeof response.status === 'function'
  ) {
    response.status(status);
  }
}

// The request-replay subsystem lives in ./request-replay.js; `ReplayResult` is
// re-exported here so it stays on the package's public surface (index `export *`).
export type { ReplayResult };
