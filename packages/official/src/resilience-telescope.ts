// packages/official/src/resilience-telescope.ts
import {
  TELESCOPE_STORAGE,
  collectEntriesInWindow,
  durationToMs,
  telescopeRecord,
} from '@dudousxd/nestjs-telescope';
import type {
  DashboardSpec,
  DataProvider,
  Entry,
  ExtensionContext,
  Panel,
  StorageProvider,
  TelescopeExtension,
} from '@dudousxd/nestjs-telescope';
import { OfficialEntryType, RESILIENCE_EVENT_TYPES } from './channels.js';

// ── live state: `@nestjs/resilience`'s ResilienceService, re-declared structurally ──────────────

/** The parts of `CircuitBreakerPolicy` the page reads. */
interface LiveBreaker {
  readonly name: string;
  readonly state: string;
  readonly stats: { total: number; failures: number; failureRate: number };
  readonly options: { failureRateThreshold: number; openDuration: number; minimumCalls: number };
  reset(): void;
}

/** The parts of `BulkheadPolicy` the page reads. */
interface LiveBulkhead {
  readonly name: string;
  readonly active: number;
  readonly queued: number;
  readonly maxConcurrent: number;
  readonly maxQueue: number;
}

/** The parts of `ResilienceService` the page reads. */
interface LiveResilience {
  circuitBreakers(): LiveBreaker[];
  bulkheads(): LiveBulkhead[];
  circuitBreaker(name: string): LiveBreaker;
}

let serviceClass: Promise<unknown> | undefined;

/** The application's `ResilienceService`, or `null` when `@nestjs/resilience` is not installed or not imported. */
async function liveResilience(ctx: ExtensionContext): Promise<LiveResilience | null> {
  serviceClass ??= import('@nestjs/resilience').then(
    (mod) => mod.ResilienceService as unknown,
    () => null,
  );
  const token = await serviceClass;
  if (typeof token !== 'function') return null;
  try {
    const service = ctx.moduleRef.get(token as new (...args: never[]) => unknown, {
      strict: false,
    });
    return isLiveResilience(service) ? service : null;
  } catch {
    return null;
  }
}

function isLiveResilience(value: unknown): value is LiveResilience {
  const candidate = value as Partial<LiveResilience> | null;
  return (
    typeof candidate?.circuitBreakers === 'function' &&
    typeof candidate.bulkheads === 'function' &&
    typeof candidate.circuitBreaker === 'function'
  );
}

/** When the breaker opened. `openedAt` is internal to `CircuitBreakerPolicy` (0.0.3), read defensively. */
function openedAtOf(breaker: LiveBreaker): number | null {
  const openedAt = (breaker as unknown as { openedAt?: unknown }).openedAt;
  return typeof openedAt === 'number' && openedAt > 0 ? openedAt : null;
}

// ── history: the `resilience` entries `NestResilienceWatcher` records ────────────────────────────

interface ResilienceEvent {
  id: string;
  at: number;
  event: string;
  policy: string;
  content: Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function toEvent(entry: Entry): ResilienceEvent | null {
  const content = entry.content as Record<string, unknown> | null;
  if (content === null || typeof content !== 'object') return null;
  const event = str(content.event);
  if (event === undefined) return null;
  return {
    id: entry.id,
    at: new Date(entry.createdAt).getTime(),
    event,
    policy: str(content.policy) ?? 'unknown',
    content,
  };
}

/** The event a reset from Telescope records next to the breaker's own `circuit-closed`. */
const RESET_EVENT = 'circuit-reset';
const TRANSITIONS = new Set(['circuit-open', 'circuit-half-open', 'circuit-closed', RESET_EVENT]);
/** Events that say a policy is under strain: they rank the noisiest policies. */
const NOISE = new Set([
  'retry',
  'timeout',
  'circuit-rejected',
  'bulkhead-rejected',
  'rate-limited',
  'fallback',
]);

/** How long one read of the window is shared by the panels of a page load. */
const READ_TTL_MS = 2_000;

class History {
  private cached: { at: number; events: Promise<ResilienceEvent[]> } | undefined;

  constructor(private readonly windowMs: number) {}

  /** Two windows of events (the current one and the one before, for the deltas), newest first. */
  read(ctx: ExtensionContext): Promise<ResilienceEvent[]> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < READ_TTL_MS) return this.cached.events;
    const events = this.load(ctx, now).catch((error: unknown) => {
      this.cached = undefined;
      throw error;
    });
    this.cached = { at: now, events };
    return events;
  }

  private async load(ctx: ExtensionContext, now: number): Promise<ResilienceEvent[]> {
    let storage: StorageProvider;
    try {
      storage = ctx.moduleRef.get<StorageProvider>(TELESCOPE_STORAGE, { strict: false });
    } catch {
      return [];
    }
    const { entries } = await collectEntriesInWindow(storage, {
      type: OfficialEntryType.Resilience,
      after: new Date(now - 2 * this.windowMs),
    });
    return entries.map(toEvent).filter((event): event is ResilienceEvent => event !== null);
  }
}

// ── providers ─────────────────────────────────────────────────────────────────────────────────

type Query = Record<string, unknown> | undefined;

function text(query: Query, key: string): string | undefined {
  const value = query?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function positiveInt(query: Query, key: string, fallback: number): number {
  const value = Number(query?.[key]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isoTime(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '' : new Date(ms).toISOString();
}

/** One circuit, merged from the live breaker (this process) and its recorded history. */
export interface ResilienceCircuitRow {
  name: string;
  status: string;
  /** Calls in the breaker's sliding window (live only). */
  calls: number | '';
  failures: number | '';
  failureRate: string;
  threshold: string;
  /** Times it opened in the window. */
  opens: number;
  /** Calls it refused in the window. */
  shortCircuited: number;
  lastChange: string;
  /** When an open breaker lets probe calls through. */
  probesAt: string;
  /** `live` when this process holds the breaker; `history` when only recorded events know it. */
  scope: 'live' | 'history';
}

const STATUS_ORDER: Record<string, number> = { open: 0, 'half-open': 1, closed: 2, unknown: 3 };

async function circuitRows(
  ctx: ExtensionContext,
  history: History,
  windowMs: number,
): Promise<ResilienceCircuitRow[]> {
  const since = Date.now() - windowMs;
  const [live, events] = await Promise.all([liveResilience(ctx), history.read(ctx)]);
  const rows = new Map<string, ResilienceCircuitRow>();
  const lastChange = new Map<string, ResilienceEvent>();
  for (const event of events) {
    if (TRANSITIONS.has(event.event) && !lastChange.has(event.policy)) {
      lastChange.set(event.policy, event);
    }
  }
  const counts = (policy: string, type: string) =>
    events.filter((e) => e.policy === policy && e.event === type && e.at >= since).length;

  for (const breaker of live?.circuitBreakers() ?? []) {
    const status = breaker.state;
    const openedAt = openedAtOf(breaker);
    const { total, failures, failureRate } = breaker.stats;
    rows.set(breaker.name, {
      name: breaker.name,
      status,
      calls: total,
      failures,
      failureRate: `${Math.round(failureRate)}%`,
      threshold: `${breaker.options.failureRateThreshold}%`,
      opens: counts(breaker.name, 'circuit-open'),
      shortCircuited: counts(breaker.name, 'circuit-rejected'),
      lastChange: isoTime(lastChange.get(breaker.name)?.at),
      probesAt:
        status === 'open' && openedAt !== null
          ? isoTime(openedAt + breaker.options.openDuration)
          : '',
      scope: 'live',
    });
  }
  for (const [policy, event] of lastChange) {
    if (rows.has(policy)) continue;
    rows.set(policy, {
      name: policy,
      status: event.event === RESET_EVENT ? 'closed' : (str(event.content.to) ?? 'unknown'),
      calls: '',
      failures: '',
      failureRate: '',
      threshold: '',
      opens: counts(policy, 'circuit-open'),
      shortCircuited: counts(policy, 'circuit-rejected'),
      lastChange: isoTime(event.at),
      probesAt: '',
      scope: 'history',
    });
  }
  return [...rows.values()];
}

function sortAndPage<T extends object>(
  rows: T[],
  query: Query,
  filterKeys: Array<keyof T & string>,
): { rows: T[]; total: number; page: number; limit: number } {
  let result = rows;
  for (const key of filterKeys) {
    const needle = text(query, `filter.${key}`)?.toLowerCase();
    if (needle) result = result.filter((row) => String(row[key]).toLowerCase().includes(needle));
  }
  const sort = text(query, 'sort');
  if (sort !== undefined && rows.length > 0 && sort in (rows[0] as object)) {
    const dir = text(query, 'dir') === 'desc' ? -1 : 1;
    const key = sort as keyof T;
    result = [...result].sort((a, b) => {
      const x = a[key];
      const y = b[key];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }
  const limit = positiveInt(query, 'limit', 50);
  const page = positiveInt(query, 'page', 1);
  return {
    rows: result.slice((page - 1) * limit, page * limit),
    total: result.length,
    page,
    limit,
  };
}

/** Counted events per stat card. `open` / `half-open` are the circuits in that state now. */
const STAT_EVENTS: Record<string, string> = {
  'short-circuited': 'circuit-rejected',
  retries: 'retry',
  timeouts: 'timeout',
  fallbacks: 'fallback',
  'bulkhead-rejected': 'bulkhead-rejected',
  'rate-limited': 'rate-limited',
  opened: 'circuit-open',
};

const BUCKETS = 12;

function windowLabel(window: string): string {
  return window.replace(/\s+/g, '');
}

// ── reset ─────────────────────────────────────────────────────────────────────────────────────

class StatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Closes the breaker `name` and records who did it. */
async function resetCircuit(
  ctx: ExtensionContext,
  name: unknown,
  caller: { id: string; via: string },
): Promise<{ name: string; from: string; state: string }> {
  if (typeof name !== 'string' || name === '') throw new StatusError('`name` is required.', 400);
  const live = await liveResilience(ctx);
  if (live === null) {
    throw new StatusError(
      "@nestjs/resilience's ResilienceService is not available in this application.",
      503,
    );
  }
  const breaker = live.circuitBreakers().find((candidate) => candidate.name === name);
  if (breaker === undefined) throw new StatusError(`No circuit breaker named "${name}".`, 404);
  const from = breaker.state;
  breaker.reset();
  telescopeRecord({
    type: OfficialEntryType.Resilience,
    familyHash: `${RESET_EVENT}:${name}`,
    content: {
      event: RESET_EVENT,
      policy: name,
      from,
      to: 'closed',
      by: caller.id,
      via: caller.via,
    },
    tags: [`resilience:${RESET_EVENT}`],
  });
  return { name, from, state: breaker.state };
}

// ── the extension ─────────────────────────────────────────────────────────────────────────────

export interface ResilienceTelescopeOptions {
  /** The window the counts, charts and transitions cover. Default `'1h'`. */
  window?: string;
  /**
   * The Reset button on open and half-open circuits, and the `resilience_reset_circuit` dev tool.
   * Default `true`. The button also needs `mutations: true` on `TelescopeModule`.
   */
  reset?: boolean;
}

/**
 * The "Resilience" page for `TelescopeModule.forRoot({ extensions: [...] })`: open and half-open
 * circuits, refusals, retries and timeouts over the window, the circuits and bulkheads of this
 * process, the noisiest policies and the recent breaker transitions. History comes from the
 * entries `NestResilienceWatcher` records (every instance writing to the same storage); live state
 * from `@nestjs/resilience`'s `ResilienceService` in this process, when the app imports
 * `ResilienceModule`.
 */
export function resilienceTelescopeExtension(
  options: ResilienceTelescopeOptions = {},
): TelescopeExtension {
  const window = options.window ?? '1h';
  const windowMs = durationToMs(window);
  const canReset = options.reset !== false;
  const label = windowLabel(window);
  const history = new History(windowMs);

  const byPolicy = (events: ResilienceEvent[], query: Query) => {
    const policy = text(query, 'policy');
    return policy === undefined ? events : events.filter((event) => event.policy === policy);
  };

  const providers: DataProvider[] = [
    {
      name: 'resilience.stats',
      async resolve(query, ctx) {
        const metric = text(query, 'metric') ?? '';
        if (metric === 'open' || metric === 'half-open') {
          const rows = await circuitRows(ctx, history, windowMs);
          const policy = text(query, 'policy');
          return {
            value: rows.filter(
              (row) => row.status === metric && (policy === undefined || row.name === policy),
            ).length,
          };
        }
        const type = STAT_EVENTS[metric];
        if (type === undefined) throw new StatusError(`Unknown metric "${metric}".`, 400);
        const events = byPolicy(await history.read(ctx), query).filter((e) => e.event === type);
        const since = Date.now() - windowMs;
        const value = events.filter((e) => e.at >= since).length;
        const delta = value - (events.length - value);
        return {
          value,
          delta,
          deltaLabel: `${delta >= 0 ? '+' : ''}${delta} vs previous ${label}`,
        };
      },
    },
    {
      name: 'resilience.circuits',
      async resolve(query, ctx) {
        const policy = text(query, 'policy');
        const rows = (await circuitRows(ctx, history, windowMs))
          .filter((row) => policy === undefined || row.name === policy)
          .sort(
            (a, b) =>
              (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) ||
              b.opens - a.opens ||
              a.name.localeCompare(b.name),
          );
        return sortAndPage(rows, query, ['name']);
      },
    },
    {
      name: 'resilience.bulkheads',
      async resolve(query, ctx) {
        const since = Date.now() - windowMs;
        const [live, all] = await Promise.all([liveResilience(ctx), history.read(ctx)]);
        const events = byPolicy(all, query);
        const rejected = events.filter((e) => e.event === 'bulkhead-rejected' && e.at >= since);
        const rows = new Map<string, Record<string, unknown>>();
        for (const bulkhead of live?.bulkheads() ?? []) {
          rows.set(bulkhead.name, {
            name: bulkhead.name,
            active: bulkhead.active,
            queued: bulkhead.queued,
            maxConcurrent: bulkhead.maxConcurrent,
            maxQueue: bulkhead.maxQueue,
            rejected: 0,
            lastRejected: '',
            scope: 'live',
          });
        }
        for (const event of rejected) {
          const row = rows.get(event.policy) ?? {
            name: event.policy,
            active: '',
            queued: '',
            maxConcurrent: '',
            maxQueue: '',
            rejected: 0,
            lastRejected: '',
            scope: 'history',
          };
          row.rejected = (row.rejected as number) + 1;
          if (row.lastRejected === '') row.lastRejected = isoTime(event.at);
          rows.set(event.policy, row);
        }
        const policy = text(query, 'policy');
        return {
          rows: [...rows.values()].filter((row) => policy === undefined || row.name === policy),
        };
      },
    },
    {
      name: 'resilience.rate-limiters',
      async resolve(query, ctx) {
        const since = Date.now() - windowMs;
        const events = byPolicy(await history.read(ctx), query).filter(
          (e) => e.event === 'rate-limited' && e.at >= since,
        );
        const rows = new Map<string, Record<string, unknown>>();
        for (const event of events) {
          const row = rows.get(event.policy);
          if (row) {
            row.rejected = (row.rejected as number) + 1;
            continue;
          }
          const retryAfterMs = event.content.retryAfterMs;
          rows.set(event.policy, {
            name: event.policy,
            rejected: 1,
            lastRetryAfterMs: typeof retryAfterMs === 'number' ? retryAfterMs : '',
            lastLimited: isoTime(event.at),
          });
        }
        return { rows: [...rows.values()] };
      },
    },
    {
      name: 'resilience.events-over-time',
      async resolve(query, ctx) {
        const now = Date.now();
        const bucketMs = windowMs / BUCKETS;
        const start = now - windowMs;
        const rows = Array.from({ length: BUCKETS }, (_, i) => {
          const row: { label: string } & Record<string, number> = {
            label: new Date(start + i * bucketMs).toISOString().slice(11, 16),
          } as { label: string } & Record<string, number>;
          for (const type of RESILIENCE_EVENT_TYPES) row[type] = 0;
          return row;
        });
        for (const event of byPolicy(await history.read(ctx), query)) {
          if (event.at < start) continue;
          const row = rows[Math.min(BUCKETS - 1, Math.floor((event.at - start) / bucketMs))];
          if (row !== undefined && event.event in row)
            row[event.event] = (row[event.event] ?? 0) + 1;
        }
        return { rows };
      },
    },
    {
      name: 'resilience.noisy-policies',
      async resolve(query, ctx) {
        const since = Date.now() - windowMs;
        const totals = new Map<string, number>();
        for (const event of await history.read(ctx)) {
          if (event.at < since || !NOISE.has(event.event)) continue;
          totals.set(event.policy, (totals.get(event.policy) ?? 0) + 1);
        }
        return {
          items: [...totals]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, positiveInt(query, 'limit', 10))
            .map(([policy, value]) => ({ label: policy, value, id: policy })),
        };
      },
    },
    {
      name: 'resilience.transitions',
      async resolve(query, ctx) {
        const since = Date.now() - windowMs;
        const rows = byPolicy(await history.read(ctx), query)
          .filter((e) => TRANSITIONS.has(e.event) && e.at >= since)
          .map((e) => ({
            id: e.id,
            at: isoTime(e.at),
            policy: e.policy,
            from: str(e.content.from) ?? '',
            to: e.event === RESET_EVENT ? 'closed (reset)' : (str(e.content.to) ?? ''),
            by: str(e.content.by) ?? '',
            source: str(e.content.source) ?? '',
          }));
        return sortAndPage(rows, query, ['policy']);
      },
    },
  ];

  const stat = (
    title: string,
    metric: string,
    thresholds?: { warn: number; bad: number },
  ): Panel => ({
    kind: 'stat',
    title,
    data: { provider: 'resilience.stats', query: { metric } },
    format: 'number',
    ...(thresholds ? { thresholds: { ...thresholds, direction: 'up-bad' as const } } : {}),
  });

  const dashboard: DashboardSpec = {
    id: 'resilience.overview',
    label: 'Resilience',
    navGroup: 'Libraries',
    panels: [],
    sections: [
      {
        title: 'Now',
        cols: 4,
        panels: [
          stat('Open circuits', 'open', { warn: 1, bad: 3 }),
          stat('Half-open circuits', 'half-open', { warn: 1, bad: 3 }),
          stat(`Short-circuited (${label})`, 'short-circuited'),
          stat(`Circuits opened (${label})`, 'opened'),
          stat(`Retries (${label})`, 'retries'),
          stat(`Timeouts (${label})`, 'timeouts'),
          stat(`Bulkhead rejections (${label})`, 'bulkhead-rejected'),
          stat(`Rate limited (${label})`, 'rate-limited'),
        ],
      },
      {
        title: 'Circuits',
        cols: 1,
        panels: [
          {
            kind: 'table',
            title: 'Circuits (live: this process; history: every instance)',
            data: { provider: 'resilience.circuits' },
            paged: true,
            columns: [
              { key: 'name', label: 'Circuit', sortable: true, filterable: true },
              {
                key: 'status',
                label: 'Status',
                sortable: true,
                ...(canReset
                  ? {
                      action: {
                        name: 'reset-circuit',
                        input: { name: '{name}' },
                        showWhen: { status: ['open', 'half-open'], scope: ['live'] },
                      },
                    }
                  : {}),
              },
              { key: 'calls', label: 'Calls in window', sortable: true, hideable: true },
              { key: 'failures', label: 'Failures', sortable: true, hideable: true },
              { key: 'failureRate', label: 'Failure rate', hideable: true },
              { key: 'threshold', label: 'Opens at', hideable: true },
              { key: 'opens', label: `Opened (${label})`, sortable: true },
              { key: 'shortCircuited', label: `Refused (${label})`, sortable: true },
              { key: 'lastChange', label: 'Last change', sortable: true, hideable: true },
              { key: 'probesAt', label: 'Probes at', hideable: true },
              { key: 'scope', label: 'Source', hideable: true },
            ],
          },
        ],
      },
      {
        title: 'Activity',
        cols: 2,
        panels: [
          {
            kind: 'timeseries',
            title: `Events (${label})`,
            data: { provider: 'resilience.events-over-time' },
            series: [...RESILIENCE_EVENT_TYPES],
            style: 'stacked',
          },
          {
            kind: 'topN',
            title: `Noisiest policies (${label})`,
            data: { provider: 'resilience.noisy-policies' },
            limit: 10,
            drilldown: { param: 'policy' },
          },
        ],
      },
      {
        title: 'Bulkheads and rate limiters',
        cols: 2,
        panels: [
          {
            kind: 'table',
            title: 'Bulkheads',
            data: { provider: 'resilience.bulkheads' },
            columns: [
              { key: 'name', label: 'Bulkhead' },
              { key: 'active', label: 'Running' },
              { key: 'queued', label: 'Queued' },
              { key: 'maxConcurrent', label: 'Max running' },
              { key: 'maxQueue', label: 'Max queued' },
              { key: 'rejected', label: `Rejected (${label})` },
              { key: 'lastRejected', label: 'Last rejection' },
            ],
          },
          {
            kind: 'table',
            title: 'Outbound rate limits',
            data: { provider: 'resilience.rate-limiters' },
            columns: [
              { key: 'name', label: 'Rate limit' },
              { key: 'rejected', label: `Refused (${label})` },
              { key: 'lastRetryAfterMs', label: 'Last retry after (ms)' },
              { key: 'lastLimited', label: 'Last refusal' },
            ],
          },
        ],
      },
      {
        title: 'Recent transitions',
        cols: 1,
        panels: [
          {
            kind: 'table',
            title: `Breaker transitions (${label})`,
            data: { provider: 'resilience.transitions' },
            paged: true,
            columns: [
              { key: 'at', label: 'At', link: { href: '#/entries/view/{id}' } },
              { key: 'policy', label: 'Circuit', filterable: true },
              { key: 'from', label: 'From' },
              { key: 'to', label: 'To' },
              { key: 'by', label: 'Reset by' },
              { key: 'source', label: 'Entrypoint', hideable: true },
            ],
          },
        ],
      },
    ],
  };

  return {
    name: 'resilience',
    dashboards: () => [dashboard],
    dataProviders: () => providers,
    actions: () =>
      canReset
        ? [
            {
              name: 'reset-circuit',
              label: 'Reset',
              confirm:
                'Reset circuit "{name}"? It closes now and lets every call through to the dependency again.',
              destructive: true,
              run: (input, ctx) => resetCircuit(ctx, input.name, ctx.caller),
            },
          ]
        : [],
    devTools: (ctx) => [
      {
        name: 'resilience_circuits',
        kind: 'read',
        description: `Circuit breakers (@nestjs/resilience): live state of this process (status, window calls and failures) merged with the recorded transitions of the last ${label}, open ones first, plus the bulkheads' load. Returns { items, bulkheads, next }.`,
        input: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['open', 'half-open', 'closed'],
              description: 'Only circuits in this state',
            },
            limit: {
              type: 'integer',
              description: 'Max circuits (default 20, max 100)',
              minimum: 1,
              maximum: 100,
            },
          },
        },
        run: async (input, call) => {
          const status = typeof input.status === 'string' ? input.status : undefined;
          const limit = Math.min(
            typeof input.limit === 'number' ? input.limit : 20,
            call?.limits.maxRows ?? 100,
            100,
          );
          const rows = (await circuitRows(ctx, history, windowMs))
            .filter((row) => status === undefined || row.status === status)
            .sort(
              (a, b) =>
                (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) ||
                a.name.localeCompare(b.name),
            );
          const live = await liveResilience(ctx);
          return {
            items: rows.slice(0, limit),
            bulkheads: (live?.bulkheads() ?? []).map((b) => ({
              name: b.name,
              active: b.active,
              queued: b.queued,
              maxConcurrent: b.maxConcurrent,
              maxQueue: b.maxQueue,
            })),
            next: null,
          };
        },
      },
      ...(canReset
        ? [
            {
              name: 'resilience_reset_circuit',
              kind: 'action' as const,
              destructive: true,
              description:
                'Reset a circuit breaker of this process to closed (empties its window), so calls reach the dependency again. Recorded with the caller. Returns { name, from, state }.',
              input: {
                type: 'object' as const,
                properties: { name: { type: 'string' as const, description: 'Circuit name' } },
                required: ['name'],
              },
              run: (input: Record<string, unknown>, call?: { caller: { id: string } }) =>
                resetCircuit(ctx, input.name, {
                  id: call?.caller.id ?? 'unknown',
                  via: 'dev-tools',
                }),
            },
          ]
        : []),
    ],
  };
}
