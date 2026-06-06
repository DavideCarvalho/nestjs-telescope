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
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { durationToMs } from '../config/parse-duration.js';
import type { QueryContent, RequestContent } from '../entry/content.js';
import { type Entry, EntryType } from '../entry/entry.js';
import { collectEntriesInWindow } from '../metrics/collect-window.js';
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

  // Request REPLAY. Re-issues a captured request entry against the local server
  // and reports the outcome. It is a MUTATION (it actually hits the app, which
  // may write), so — like `prune` — it stays behind the default-deny
  // authorizeAction gate rather than the read guard. The queue-shaped
  // TelescopeActionGuard can't validate it (no driver/queue/action params), so we
  // enforce the same default-deny here directly: no `authorizeAction` → 403.
  @Get('entries/:id/replay')
  async replay(@Param('id') id: string, @Req() request: unknown): Promise<ReplayResult> {
    if (!this.options.authorizeAction) {
      throw new ForbiddenException('Mutations are disabled (no authorizeAction configured).');
    }
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

  // ── AI exception diagnosis ──────────────────────────────────────────────────

  // Read-shaped ANALYSIS (it produces a markdown explanation, mutates no
  // Telescope state and runs no destructive action), so — like `explain` — it
  // sits behind the normal dashboard read guard, NOT the default-deny
  // authorizeAction mutation gate. 404 when AI isn't configured or the entry
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
  // bare "Diagnose with AI" button. Same guards/404 semantics as the POST:
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

  @Delete('entries')
  async clear(): Promise<{ cleared: true }> {
    await this.storage.clear();
    return { cleared: true };
  }
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

/** Outcome of a request replay (see {@link TelescopeController.replay}). */
export interface ReplayResult {
  /** HTTP status of the replayed response, or `0` when the call never completed. */
  status: number;
  /** Wall-clock duration of the replay in ms. */
  durationMs: number;
  /** The response body, capped at {@link REPLAY_BODY_CAP} bytes. */
  body: string;
  /** Present when the replay failed to complete (timeout / network error). */
  error?: string;
}

const REPLAY_TIMEOUT_MS = 30_000;
/** Max bytes of the replayed response body returned (4 KB). */
const REPLAY_BODY_CAP = 4096;
/** Headers stripped from the replayed request (auth/session/routing leakage). */
const REPLAY_STRIPPED_HEADERS = new Set(['cookie', 'authorization', 'host', 'content-length']);

/**
 * Re-issue a captured request against the LOCAL server (127.0.0.1:<port>) so a
 * developer can reproduce it from the dashboard. The replay carries a
 * `x-telescope-replay: 1` header (so the host can recognize/skip it) and strips
 * cookie/authorization/host headers — a replay must not silently reuse the
 * original caller's credentials. Bounded by a 30s timeout; the body is capped at
 * 4 KB. Never throws — a failed call returns `status: 0` with an `error`.
 */
async function replayRequest(content: RequestContent, request: unknown): Promise<ReplayResult> {
  const port = resolveLocalPort(request);
  const path = content.uri.startsWith('/') ? content.uri : `/${content.uri}`;
  const url = `http://127.0.0.1:${port}${path}`;
  const headers = buildReplayHeaders(content.headers);
  const method = (content.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && content.payload != null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(hasBody ? { body: serializePayload(content.payload, headers) } : {}),
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await response.text();
    return {
      status: response.status,
      durationMs: Date.now() - startedAt,
      body: text.slice(0, REPLAY_BODY_CAP),
    };
  } catch (error: unknown) {
    return {
      status: 0,
      durationMs: Date.now() - startedAt,
      body: '',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Copy headers minus the stripped set, and force `x-telescope-replay: 1`. */
function buildReplayHeaders(source: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (REPLAY_STRIPPED_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') headers[key] = value[0];
  }
  headers['x-telescope-replay'] = '1';
  return headers;
}

/** Serialize a captured payload to a fetch body, defaulting to JSON. */
function serializePayload(payload: unknown, headers: Record<string, string>): string {
  if (typeof payload === 'string') return payload;
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (!hasContentType) headers['content-type'] = 'application/json';
  return JSON.stringify(payload);
}

/** Resolve the local server port from the incoming request's socket/host header. */
function resolveLocalPort(request: unknown): number {
  if (typeof request === 'object' && request !== null) {
    const socket = (request as { socket?: { localPort?: unknown } }).socket;
    if (socket && typeof socket.localPort === 'number' && socket.localPort > 0) {
      return socket.localPort;
    }
    const headers = (request as { headers?: Record<string, unknown> }).headers;
    const host = headers?.host;
    if (typeof host === 'string') {
      const portPart = host.split(':')[1];
      const parsed = portPart !== undefined ? Number(portPart) : Number.NaN;
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  // Fall back to PORT env or the conventional 3000.
  const envPort = Number(process.env.PORT);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;
}
