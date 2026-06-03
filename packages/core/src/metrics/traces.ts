// packages/core/src/metrics/traces.ts
import { EntryType } from '../entry/entry.js';
import type { Entry } from '../entry/entry.js';

export interface TraceSummary {
  traceId: string;
  /** Number of entries that share this traceId. */
  entryCount: number;
  /** Distinct entry types in the trace, sorted ascending. */
  types: string[];
  /** Earliest `createdAt` across the trace's entries. */
  firstAt: Date;
  /** Latest `createdAt` across the trace's entries. */
  lastAt: Date;
  /** Sum of non-null `durationMs` across the trace's entries. */
  totalDurationMs: number;
  /** The request entry's "METHOD uri" label, when the trace has one. */
  rootLabel?: string;
}

export interface SummarizeTracesOptions {
  limit?: number;
}

const DEFAULT_LIMIT = 50;

/** Narrows an entry's content to the request shape (method + uri). */
function asRequestLabel(content: unknown): string | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(content));
  const uri = record.uri;
  const method = record.method;
  if (typeof uri !== 'string') return undefined;
  return typeof method === 'string' ? `${method} ${uri}` : uri;
}

interface TraceAccumulator {
  traceId: string;
  entryCount: number;
  types: Set<string>;
  firstAt: Date;
  lastAt: Date;
  totalDurationMs: number;
  rootLabel?: string;
}

/** Groups window entries by `traceId` (null trace ids skipped) into a summary
 *  per distinct trace, sorted by `lastAt` desc and sliced to `limit`. Pure. */
export function summarizeTraces(
  entries: Entry[],
  options: SummarizeTracesOptions = {},
): TraceSummary[] {
  const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_LIMIT));
  const byTrace = new Map<string, TraceAccumulator>();

  for (const entry of entries) {
    const traceId = entry.traceId;
    if (traceId === null) continue;

    let accumulator = byTrace.get(traceId);
    if (accumulator === undefined) {
      accumulator = {
        traceId,
        entryCount: 0,
        types: new Set<string>(),
        firstAt: entry.createdAt,
        lastAt: entry.createdAt,
        totalDurationMs: 0,
      };
      byTrace.set(traceId, accumulator);
    }

    accumulator.entryCount += 1;
    accumulator.types.add(entry.type);
    if (entry.createdAt.getTime() < accumulator.firstAt.getTime()) {
      accumulator.firstAt = entry.createdAt;
    }
    if (entry.createdAt.getTime() > accumulator.lastAt.getTime()) {
      accumulator.lastAt = entry.createdAt;
    }
    if (entry.durationMs !== null) {
      accumulator.totalDurationMs += entry.durationMs;
    }
    if (accumulator.rootLabel === undefined && entry.type === EntryType.Request) {
      const label = asRequestLabel(entry.content);
      if (label !== undefined) accumulator.rootLabel = label;
    }
  }

  const summaries: TraceSummary[] = [];
  for (const accumulator of byTrace.values()) {
    summaries.push({
      traceId: accumulator.traceId,
      entryCount: accumulator.entryCount,
      types: [...accumulator.types].sort(),
      firstAt: accumulator.firstAt,
      lastAt: accumulator.lastAt,
      totalDurationMs: accumulator.totalDurationMs,
      ...(accumulator.rootLabel !== undefined ? { rootLabel: accumulator.rootLabel } : {}),
    });
  }

  summaries.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
  return summaries.slice(0, limit);
}
