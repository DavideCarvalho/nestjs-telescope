// packages/core/src/pulse/pulse-summary.ts
import { type Entry, EntryType } from '../entry/entry.js';
import { percentile } from '../metrics/stats.js';
import { detectNPlusOne } from '../query/n-plus-one.js';

export interface SlowEntry {
  id: string;
  type: string;
  durationMs: number;
  label: string;
  batchId: string;
}

export interface ExceptionGroup {
  familyHash: string;
  class: string;
  message: string;
  count: number;
  lastSeen: string;
}

export interface NPlusOneHotspot {
  familyHash: string;
  sql: string;
  /** Worst (max) repetition count of this family within a single request/batch. */
  perRequest: number;
  /** Number of distinct requests/batches where this family tripped the threshold. */
  requests: number;
  /** Sum of repetition counts across those requests. */
  total: number;
  /**
   * Total duration (ms) spent across ALL occurrences of this family in the
   * window — the time "wasted" in the loop. Lets the dashboard weight an N+1 by
   * cost, not just repetition count (a 200×1ms loop vs a 6×80ms loop). Derived
   * from the content-less `durationMs` column, so it needs no hydration.
   */
  totalDurationMs: number;
  /** One batch id (the worst) to deep-link to. */
  sampleBatchId: string;
}

/**
 * A consistently-slow endpoint, aggregated by route family. The `route` IS the
 * normalized `familyHash` (e.g. "GET /api/base/:id/mel"), so it doubles as the
 * label — fully derived from content-less columns, no hydration.
 */
export interface SlowRouteHotspot {
  /** The normalized route family — equals the request entry's `familyHash`. */
  route: string;
  count: number;
  p99: number;
  p50: number;
}

/**
 * A user's share of the load in the window — request count and the total time
 * spent serving them. The `user` is the id from the request's `user:<id>` tag.
 * Modelled on Laravel Pulse's "Usage" card.
 */
export interface UserLoad {
  user: string;
  count: number;
  totalDurationMs: number;
}

export interface PulseSummary {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  counts: Record<string, number>;
  slowest: SlowEntry[];
  topExceptions: ExceptionGroup[];
  nPlusOne: NPlusOneHotspot[];
  slowRoutes: SlowRouteHotspot[];
  slowOutgoing: SlowRouteHotspot[];
  /** Slowest job families (by p99), the queue analogue of `slowRoutes`. */
  slowJobs: SlowRouteHotspot[];
  /** Top users by total request time in the window. */
  loadByUser: UserLoad[];
}

export interface PulseOptions {
  topN: number;
  nPlusOneThreshold: number;
  /** Minimum request count for a route to qualify as a slow-route hotspot. */
  slowRouteMinCount: number;
  /**
   * Minimum p99 (ms) for a route family to count as a slow-route hotspot. A
   * route only surfaces here when its p99 is **>= slowRouteMs** — a hotspot is a
   * route that is *actually slow*, not merely the slowest of an otherwise-healthy
   * set. Without this gate, "Slow request hotspots" is a pure top-N p99 ranking,
   * so on a quiet host it surfaces e.g. `/health` at 18ms and reads as a false
   * alarm. The default (1000) matches the `slow` request tag threshold
   * (`SLOW_THRESHOLD_MS` in tagging/tagger.ts) and the HttpClientWatcher's
   * `slowMs` default, so "hotspot" means the same thing here as the `slow` tag
   * does everywhere else. Applies to both incoming slow-route and outgoing
   * slow-HTTP hotspots (both are p99 route rankings).
   */
  slowRouteMs: number;
}

/**
 * The exact set of entry ids whose `content` the final pulse output displays.
 * Everything else aggregates over content-less columns, so a caller can run a
 * content-less primary scan and then hydrate only THESE ids:
 *  - `slowest`: the top-N slowest entries (labels come from content).
 *  - `exceptions`: one representative per reported exception family (class/message).
 *  - `nPlusOne`: one representative query entry per reported N+1 family (sql).
 */
export interface PulseHydrationIds {
  slowest: string[];
  exceptions: string[];
  nPlusOne: string[];
}

/** A content lookup for a previously-identified id; returns the hydrated content
 *  or undefined when the entry could not be re-read (e.g. since pruned). */
export type HydrateContent = (id: string) => unknown;

const MAX_LABEL_LENGTH = 500;

/** Bound a label/sql string so the health snapshot payload stays small. */
function truncate(value: string): string {
  return value.length > MAX_LABEL_LENGTH ? `${value.slice(0, MAX_LABEL_LENGTH)}…` : value;
}

/**
 * Aggregate per-family durations into ranked {@link SlowRouteHotspot}s. The map
 * key IS the `route` (familyHash, also the label); stats are p99/p50 over the
 * family's durations. Shared by request slow-routes and outgoing-HTTP hotspots.
 */
function toHotspots(
  durationsByFamily: Map<string, number[]>,
  options: PulseOptions,
): SlowRouteHotspot[] {
  return [...durationsByFamily.entries()]
    .map(([route, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b);
      return {
        route,
        count: sorted.length,
        p99: percentile(sorted, 0.99),
        p50: percentile(sorted, 0.5),
      };
    })
    .filter(
      (hotspot) => hotspot.count >= options.slowRouteMinCount && hotspot.p99 >= options.slowRouteMs,
    )
    .sort((a, b) => b.p99 - a.p99 || b.count - a.count || a.route.localeCompare(b.route))
    .slice(0, options.topN);
}

function asRecord(content: unknown): Record<string, unknown> | null {
  return typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)
    : null;
}

/** A human label for a slow entry, derived from hydrated content by type. */
function labelFrom(type: string, content: unknown): string {
  const record = asRecord(content);
  if (record === null) return type;
  if (typeof record.uri === 'string') {
    return typeof record.method === 'string' ? `${record.method} ${record.uri}` : record.uri;
  }
  if (typeof record.sql === 'string') return record.sql;
  if (typeof record.queue === 'string' && typeof record.name === 'string') {
    return `${record.queue}:${record.name}`;
  }
  return type;
}

interface SlowCandidate {
  id: string;
  type: string;
  durationMs: number;
  batchId: string;
}

interface ExceptionAccumulator {
  /** A representative entry id to hydrate class/message from. */
  representativeId: string;
  count: number;
  lastSeen: Date;
}

interface ExceptionGroupAggregate extends ExceptionAccumulator {
  familyHash: string;
}

interface NPlusOneAccumulator {
  familyHash: string;
  perRequest: number;
  requests: number;
  total: number;
  totalDurationMs: number;
  sampleBatchId: string;
  /** A representative query entry id to hydrate the sql from. */
  representativeId: string;
}

/**
 * What `summarizePulse` derives from the content-less columns alone, BEFORE any
 * content hydration: counts, the ranked slowest candidates, exception groups
 * (without class/message), and N+1 hotspots (without sql). The pulse service
 * hydrates the ids in {@link hydrationIds} and calls {@link finalizePulse}.
 */
export interface PulseAggregates {
  windowStart: Date;
  windowEnd: Date;
  options: PulseOptions;
  counts: Record<string, number>;
  slowest: SlowCandidate[];
  exceptions: ExceptionGroupAggregate[];
  nPlusOne: NPlusOneAccumulator[];
  /**
   * Slow-route hotspots, already final: the route IS the familyHash and the
   * stats come from content-less columns, so no hydration is required.
   */
  slowRoutes: SlowRouteHotspot[];
  /**
   * Slow outgoing-HTTP hotspots, already final: the `route` IS the http_client
   * familyHash (method + host + normalized path) and the stats come from
   * content-less columns, so no hydration is required.
   */
  slowOutgoing: SlowRouteHotspot[];
  /** Slowest job families, already final (familyHash is the label). */
  slowJobs: SlowRouteHotspot[];
  /** Top users by request time, already final (no hydration needed). */
  loadByUser: UserLoad[];
  hydrationIds: PulseHydrationIds;
}

/**
 * Pass 1: aggregate the windowed entries over their content-less columns only.
 * Reads `type`, `durationMs`, `familyHash`, `batchId`, `createdAt`, `sequence`
 * — never `content`. Produces the ranked/sliced aggregates plus the exact ids
 * whose content the final output needs.
 */
export function aggregatePulse(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
  options: PulseOptions,
): PulseAggregates {
  const counts: Record<string, number> = {};
  const slowCandidates: SlowCandidate[] = [];
  const exceptionGroups = new Map<string, ExceptionAccumulator>();
  const batches = new Map<string, Entry[]>();
  // Request durations grouped by route family — the slow-route hotspot source.
  const routeDurations = new Map<string, number[]>();
  // Outgoing http_client durations grouped by target family — slow-outgoing source.
  const outgoingDurations = new Map<string, number[]>();
  // Job durations grouped by job family — slow-jobs source.
  const jobDurations = new Map<string, number[]>();
  // Per-user request load (count + total duration) from the user:<id> tag.
  const userLoad = new Map<string, { count: number; totalDurationMs: number }>();

  for (const entry of entries) {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1;

    if (
      entry.type === EntryType.Job &&
      entry.familyHash !== null &&
      typeof entry.durationMs === 'number'
    ) {
      const existing = jobDurations.get(entry.familyHash);
      if (existing) existing.push(entry.durationMs);
      else jobDurations.set(entry.familyHash, [entry.durationMs]);
    }

    if (entry.type === EntryType.Request) {
      const user = userFromTags(entry.tags);
      if (user !== null) {
        const existing = userLoad.get(user);
        const duration = typeof entry.durationMs === 'number' ? entry.durationMs : 0;
        if (existing) {
          existing.count += 1;
          existing.totalDurationMs += duration;
        } else {
          userLoad.set(user, { count: 1, totalDurationMs: duration });
        }
      }
    }

    if (
      entry.type === EntryType.Request &&
      entry.familyHash !== null &&
      typeof entry.durationMs === 'number'
    ) {
      const existing = routeDurations.get(entry.familyHash);
      if (existing) existing.push(entry.durationMs);
      else routeDurations.set(entry.familyHash, [entry.durationMs]);
    }

    if (
      entry.type === EntryType.HttpClient &&
      entry.familyHash !== null &&
      typeof entry.durationMs === 'number'
    ) {
      const existing = outgoingDurations.get(entry.familyHash);
      if (existing) existing.push(entry.durationMs);
      else outgoingDurations.set(entry.familyHash, [entry.durationMs]);
    }

    if (typeof entry.durationMs === 'number') {
      slowCandidates.push({
        id: entry.id,
        type: entry.type,
        durationMs: entry.durationMs,
        batchId: entry.batchId,
      });
    }

    if (entry.type === EntryType.Exception && entry.familyHash !== null) {
      const existing = exceptionGroups.get(entry.familyHash);
      if (existing) {
        existing.count += 1;
        if (entry.createdAt > existing.lastSeen) {
          existing.lastSeen = entry.createdAt;
          existing.representativeId = entry.id;
        }
      } else {
        exceptionGroups.set(entry.familyHash, {
          representativeId: entry.id,
          count: 1,
          lastSeen: entry.createdAt,
        });
      }
    }

    const batch = batches.get(entry.batchId);
    if (batch) batch.push(entry);
    else batches.set(entry.batchId, [entry]);
  }

  const slowest = slowCandidates
    .sort((a, b) => b.durationMs - a.durationMs || a.id.localeCompare(b.id))
    .slice(0, options.topN);

  const exceptions = [...exceptionGroups.entries()]
    .map(([familyHash, group]) => ({ familyHash, group }))
    .sort((a, b) => b.group.count - a.group.count || a.familyHash.localeCompare(b.familyHash))
    .slice(0, options.topN)
    .map(({ familyHash, group }) => ({ familyHash, ...group }));

  // N+1 detection only needs familyHash counts per batch; sql is hydrated later.
  // We track one representative query-entry id per family for the sql label.
  const hotspots = new Map<string, NPlusOneAccumulator>();
  const familyRepresentative = new Map<string, string>();
  for (const [batchId, batchEntries] of batches) {
    // Sum query durations per family WITHIN this batch (content-less column) so a
    // tripped N+1 family can be weighted by the time it actually cost.
    const batchFamilyDuration = new Map<string, number>();
    for (const entry of batchEntries) {
      if (entry.type === EntryType.Query && entry.familyHash !== null) {
        if (!familyRepresentative.has(entry.familyHash)) {
          familyRepresentative.set(entry.familyHash, entry.id);
        }
        if (typeof entry.durationMs === 'number') {
          batchFamilyDuration.set(
            entry.familyHash,
            (batchFamilyDuration.get(entry.familyHash) ?? 0) + entry.durationMs,
          );
        }
      }
    }
    for (const insight of detectNPlusOne(batchEntries, options.nPlusOneThreshold)) {
      const loopDuration = batchFamilyDuration.get(insight.familyHash) ?? 0;
      const existing = hotspots.get(insight.familyHash);
      if (existing) {
        existing.requests += 1;
        existing.total += insight.count;
        existing.totalDurationMs += loopDuration;
        if (insight.count > existing.perRequest) {
          existing.perRequest = insight.count;
          existing.sampleBatchId = batchId;
        }
      } else {
        hotspots.set(insight.familyHash, {
          familyHash: insight.familyHash,
          perRequest: insight.count,
          requests: 1,
          total: insight.count,
          totalDurationMs: loopDuration,
          sampleBatchId: batchId,
          representativeId: familyRepresentative.get(insight.familyHash) ?? '',
        });
      }
    }
  }
  // Rank by total time WASTED in the loop first (cost-weighted, the actionable
  // signal), then by repetition totals as the tie-break.
  const nPlusOne = [...hotspots.values()]
    .sort(
      (a, b) =>
        b.totalDurationMs - a.totalDurationMs ||
        b.total - a.total ||
        b.requests - a.requests ||
        a.familyHash.localeCompare(b.familyHash),
    )
    .slice(0, options.topN);

  // Slow-route hotspots: aggregate request durations per route family entirely
  // from content-less columns. The route IS the familyHash (also the label).
  const slowRoutes = toHotspots(routeDurations, options);
  // Slow outgoing-HTTP hotspots: same aggregation over http_client durations.
  const slowOutgoing = toHotspots(outgoingDurations, options);
  // Slow-job hotspots: rank job families by p99. Unlike routes/outgoing, jobs
  // are NOT gated by the slow-request p99 threshold — a queue's slowest jobs are
  // always worth surfacing — so they rank by p99 over the min-count gate only.
  const slowJobs = toJobHotspots(jobDurations, options);
  // Load-by-user: top users by total request time spent serving them.
  const loadByUser = [...userLoad.entries()]
    .map(([user, load]) => ({ user, count: load.count, totalDurationMs: load.totalDurationMs }))
    .sort(
      (a, b) =>
        b.totalDurationMs - a.totalDurationMs || b.count - a.count || a.user.localeCompare(b.user),
    )
    .slice(0, options.topN);

  return {
    windowStart,
    windowEnd,
    options,
    counts,
    slowest,
    exceptions,
    nPlusOne,
    slowRoutes,
    slowOutgoing,
    slowJobs,
    loadByUser,
    hydrationIds: {
      slowest: slowest.map((candidate) => candidate.id),
      exceptions: exceptions.map((group) => group.representativeId),
      nPlusOne: nPlusOne.map((hotspot) => hotspot.representativeId),
    },
  };
}

/**
 * Rank job families by p99 over a min-count gate (no slow-ms threshold — the
 * slowest jobs are always worth showing). Shares the {@link SlowRouteHotspot}
 * shape so the dashboard renders it with the same hotspot card. Pure.
 */
function toJobHotspots(
  durationsByFamily: Map<string, number[]>,
  options: PulseOptions,
): SlowRouteHotspot[] {
  return [...durationsByFamily.entries()]
    .map(([route, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b);
      return {
        route,
        count: sorted.length,
        p99: percentile(sorted, 0.99),
        p50: percentile(sorted, 0.5),
      };
    })
    .filter((hotspot) => hotspot.count >= options.slowRouteMinCount)
    .sort((a, b) => b.p99 - a.p99 || b.count - a.count || a.route.localeCompare(b.route))
    .slice(0, options.topN);
}

/** Extract the user id from a `user:<id>` tag, or `null` when none is present. */
function userFromTags(tags: string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith('user:')) return tag.slice('user:'.length);
  }
  return null;
}

/** detectNPlusOne re-derives sql from a hydrated representative's content. */
function sqlFromContent(content: unknown): string {
  const record = asRecord(content);
  return record !== null && typeof record.sql === 'string' ? record.sql : '';
}

function exceptionFieldsFromContent(content: unknown): { class: string; message: string } {
  const record = asRecord(content);
  return {
    class: typeof record?.class === 'string' ? record.class : 'Error',
    message: typeof record?.message === 'string' ? record.message : '',
  };
}

/**
 * Pass 2: build the final {@link PulseSummary}, reading content for ONLY the few
 * displayed rows via the `hydrate` lookup. `hydrate(id)` returns the entry's
 * content (or undefined if it could not be re-read).
 */
export function finalizePulse(aggregates: PulseAggregates, hydrate: HydrateContent): PulseSummary {
  const slowest: SlowEntry[] = aggregates.slowest.map((candidate) => ({
    id: candidate.id,
    type: candidate.type,
    durationMs: candidate.durationMs,
    label: truncate(labelFrom(candidate.type, hydrate(candidate.id))),
    batchId: candidate.batchId,
  }));

  const topExceptions: ExceptionGroup[] = aggregates.exceptions.map((group) => {
    const { class: className, message } = exceptionFieldsFromContent(
      hydrate(group.representativeId),
    );
    return {
      familyHash: group.familyHash,
      class: className,
      message,
      count: group.count,
      lastSeen: group.lastSeen.toISOString(),
    };
  });

  const nPlusOne: NPlusOneHotspot[] = aggregates.nPlusOne.map((hotspot) => ({
    familyHash: hotspot.familyHash,
    sql: truncate(sqlFromContent(hydrate(hotspot.representativeId))),
    perRequest: hotspot.perRequest,
    requests: hotspot.requests,
    total: hotspot.total,
    totalDurationMs: hotspot.totalDurationMs,
    sampleBatchId: hotspot.sampleBatchId,
  }));

  return {
    windowStart: aggregates.windowStart.toISOString(),
    windowEnd: aggregates.windowEnd.toISOString(),
    windowMs: Math.max(0, aggregates.windowEnd.getTime() - aggregates.windowStart.getTime()),
    counts: aggregates.counts,
    slowest,
    topExceptions,
    nPlusOne,
    // Slow routes are already final (familyHash is the label) — pass through.
    slowRoutes: aggregates.slowRoutes,
    slowOutgoing: aggregates.slowOutgoing,
    slowJobs: aggregates.slowJobs,
    loadByUser: aggregates.loadByUser,
  };
}

/**
 * Summarize stored entries into a health snapshot: per-type counts, slowest
 * entries, top exceptions, and N+1 hotspots aggregated by query family. Pure:
 * callers fetch the windowed entries (createdAt is not re-checked here).
 *
 * When the entries carry their `content` (the in-process / single-pass path),
 * labels/class/message/sql resolve directly from each entry. The two-pass
 * content-less path uses {@link aggregatePulse} + {@link finalizePulse} instead.
 */
export function summarizePulse(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
  options: PulseOptions,
): PulseSummary {
  const aggregates = aggregatePulse(entries, windowStart, windowEnd, options);
  const byId = new Map<string, unknown>();
  for (const entry of entries) byId.set(entry.id, entry.content);
  return finalizePulse(aggregates, (id) => byId.get(id));
}
