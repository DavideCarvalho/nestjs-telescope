// packages/core/src/pulse/pulse-summary.ts
import { type Entry, EntryType } from '../entry/entry.js';
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
  /** One batch id (the worst) to deep-link to. */
  sampleBatchId: string;
}

export interface PulseSummary {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  counts: Record<string, number>;
  slowest: SlowEntry[];
  topExceptions: ExceptionGroup[];
  nPlusOne: NPlusOneHotspot[];
}

export interface PulseOptions {
  topN: number;
  nPlusOneThreshold: number;
}

const MAX_LABEL_LENGTH = 500;

/** Bound a label/sql string so the health snapshot payload stays small. */
function truncate(value: string): string {
  return value.length > MAX_LABEL_LENGTH ? `${value.slice(0, MAX_LABEL_LENGTH)}…` : value;
}

function asRecord(content: unknown): Record<string, unknown> | null {
  return typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)
    : null;
}

/** A human label for a slow entry, derived from its content by type. */
function labelFor(entry: Entry): string {
  const record = asRecord(entry.content);
  if (record === null) return entry.type;
  if (typeof record.uri === 'string') {
    return typeof record.method === 'string' ? `${record.method} ${record.uri}` : record.uri;
  }
  if (typeof record.sql === 'string') return record.sql;
  if (typeof record.queue === 'string' && typeof record.name === 'string') {
    return `${record.queue}:${record.name}`;
  }
  return entry.type;
}

interface ExceptionAccumulator {
  class: string;
  message: string;
  count: number;
  lastSeen: Date;
}

/** Summarize stored entries into a health snapshot: per-type counts, slowest
 *  entries, top exceptions, and N+1 hotspots aggregated by query family. Pure: callers fetch
 *  the windowed entries (createdAt is not re-checked here). */
export function summarizePulse(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
  options: PulseOptions,
): PulseSummary {
  const counts: Record<string, number> = {};
  const slowCandidates: SlowEntry[] = [];
  const exceptionGroups = new Map<string, ExceptionAccumulator>();
  const batches = new Map<string, Entry[]>();

  for (const entry of entries) {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1;

    if (typeof entry.durationMs === 'number') {
      slowCandidates.push({
        id: entry.id,
        type: entry.type,
        durationMs: entry.durationMs,
        label: truncate(labelFor(entry)),
        batchId: entry.batchId,
      });
    }

    if (entry.type === EntryType.Exception && entry.familyHash !== null) {
      const record = asRecord(entry.content);
      const existing = exceptionGroups.get(entry.familyHash);
      if (existing) {
        existing.count += 1;
        if (entry.createdAt > existing.lastSeen) existing.lastSeen = entry.createdAt;
      } else {
        exceptionGroups.set(entry.familyHash, {
          class: typeof record?.class === 'string' ? record.class : 'Error',
          message: typeof record?.message === 'string' ? record.message : '',
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

  const topExceptions = [...exceptionGroups.entries()]
    .map(([familyHash, group]) => ({
      familyHash,
      class: group.class,
      message: group.message,
      count: group.count,
      lastSeen: group.lastSeen.toISOString(),
    }))
    .sort((a, b) => b.count - a.count || a.familyHash.localeCompare(b.familyHash))
    .slice(0, options.topN);

  const hotspots = new Map<string, NPlusOneHotspot>();
  for (const [batchId, batchEntries] of batches) {
    for (const insight of detectNPlusOne(batchEntries, options.nPlusOneThreshold)) {
      const existing = hotspots.get(insight.familyHash);
      if (existing) {
        existing.requests += 1;
        existing.total += insight.count;
        if (insight.count > existing.perRequest) {
          existing.perRequest = insight.count;
          existing.sampleBatchId = batchId;
        }
      } else {
        hotspots.set(insight.familyHash, {
          familyHash: insight.familyHash,
          sql: truncate(insight.sql),
          perRequest: insight.count,
          requests: 1,
          total: insight.count,
          sampleBatchId: batchId,
        });
      }
    }
  }
  const nPlusOne = [...hotspots.values()].sort(
    (a, b) =>
      b.total - a.total || b.requests - a.requests || a.familyHash.localeCompare(b.familyHash),
  );

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    windowMs: Math.max(0, windowEnd.getTime() - windowStart.getTime()),
    counts,
    slowest,
    topExceptions,
    nPlusOne: nPlusOne.slice(0, options.topN),
  };
}
