// packages/core/src/metrics/waterfall.ts
import { EntryType } from '../entry/entry.js';
import type { Entry } from '../entry/entry.js';

/**
 * A single node in a trace/batch waterfall. Offsets are relative to the trace's
 * earliest start so the UI can lay each bar out as
 * `left = offsetMs / totalDurationMs`, `width = durationMs / totalDurationMs`.
 */
export interface WaterfallSpan {
  id: string;
  type: string;
  /** A human label derived from the entry's content (route, sql, queue:job, …). */
  label: string;
  /** Start offset (ms) from the trace start. */
  offsetMs: number;
  /** Span duration (ms); a null `durationMs` becomes a zero-width instant span. */
  durationMs: number;
  /** Nesting depth (0 for roots). */
  depth: number;
  /** Stable record order within the batch (the entry's `sequence`). */
  sequence: number;
  children: WaterfallSpan[];
}

export interface Waterfall {
  /** Absolute trace start (epoch ms) — the earliest entry start. */
  traceStartMs: number;
  /** Wall-clock span of the whole trace (latest end − earliest start), >= 0. */
  totalDurationMs: number;
  /** Root spans (those not contained by any other), ordered by start then sequence. */
  spans: WaterfallSpan[];
}

interface Interval {
  entry: Entry;
  startMs: number;
  /** Inclusive duration; null durations are treated as 0 (instant). */
  durationMs: number;
  endMs: number;
}

function asRecord(content: unknown): Record<string, unknown> | null {
  return typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)
    : null;
}

/** A human label for a span, derived from the entry's content by type. */
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
  if (entry.type === EntryType.HttpClient && typeof record.url === 'string') {
    return typeof record.method === 'string' ? `${record.method} ${record.url}` : record.url;
  }
  if (typeof record.name === 'string') return record.name;
  return entry.type;
}

/**
 * Reconstruct a nested span waterfall from a batch/trace's entries.
 *
 * DESIGN: the entry model carries `traceId`/`spanId` but NOT a parent-span
 * pointer, so we cannot rebuild the exact OTel span tree from explicit links.
 * Instead — exactly as Sentry/Tempo do when parent links are missing — we infer
 * nesting from **time-interval containment**: a span is a child of the tightest
 * enclosing span whose `[start, end]` strictly contains it. `sequence` provides a
 * stable tie-break for spans that start at the same instant. This yields the
 * familiar request → query/http_client → nested-op nesting from data we already
 * capture, with zero new watcher overhead.
 *
 * Returns `null` for an empty input. Pure.
 */
export function buildWaterfall(entries: Entry[]): Waterfall | null {
  if (entries.length === 0) return null;

  const intervals: Interval[] = entries.map((entry) => {
    const startMs = entry.createdAt.getTime();
    const durationMs = typeof entry.durationMs === 'number' ? Math.max(0, entry.durationMs) : 0;
    return { entry, startMs, durationMs, endMs: startMs + durationMs };
  });

  const traceStartMs = Math.min(...intervals.map((i) => i.startMs));
  const traceEndMs = Math.max(...intervals.map((i) => i.endMs));
  const totalDurationMs = Math.max(0, traceEndMs - traceStartMs);

  // Order so that enclosing spans come first: earliest start, then the LONGER
  // span first (a parent starts no later and ends no earlier than its child),
  // then sequence for a stable tie-break.
  const ordered = [...intervals].sort(
    (a, b) =>
      a.startMs - b.startMs || b.durationMs - a.durationMs || a.entry.sequence - b.entry.sequence,
  );

  const nodeById = new Map<string, WaterfallSpan>();
  const roots: WaterfallSpan[] = [];
  // A stack of currently-open ancestors, innermost last. We pop ancestors whose
  // interval does not contain the current span, then attach to the top of stack.
  const openStack: { interval: Interval; node: WaterfallSpan }[] = [];

  for (const interval of ordered) {
    while (openStack.length > 0) {
      const top = openStack[openStack.length - 1];
      if (top !== undefined && contains(top.interval, interval)) break;
      openStack.pop();
    }
    const parent = openStack[openStack.length - 1];
    const depth = parent === undefined ? 0 : parent.node.depth + 1;
    const node: WaterfallSpan = {
      id: interval.entry.id,
      type: interval.entry.type,
      label: labelFor(interval.entry),
      offsetMs: interval.startMs - traceStartMs,
      durationMs: interval.durationMs,
      depth,
      sequence: interval.entry.sequence,
      children: [],
    };
    nodeById.set(node.id, node);
    if (parent === undefined) roots.push(node);
    else parent.node.children.push(node);
    openStack.push({ interval, node });
  }

  // Order children (and roots) by start offset, then sequence.
  const byOffset = (a: WaterfallSpan, b: WaterfallSpan): number =>
    a.offsetMs - b.offsetMs || a.sequence - b.sequence;
  for (const node of nodeById.values()) node.children.sort(byOffset);
  roots.sort(byOffset);

  return { traceStartMs, totalDurationMs, spans: roots };
}

/** True when `outer` strictly encloses `inner` — it contains the interval AND is
 *  genuinely larger on at least one side. Two spans with the SAME interval are
 *  therefore siblings, not nested (a span never "contains" its identical twin),
 *  while a zero-width child inside a parent's bounds still nests. */
function contains(outer: Interval, inner: Interval): boolean {
  const encloses = outer.startMs <= inner.startMs && outer.endMs >= inner.endMs;
  const strictlyLarger = outer.startMs < inner.startMs || outer.endMs > inner.endMs;
  return encloses && strictlyLarger;
}
