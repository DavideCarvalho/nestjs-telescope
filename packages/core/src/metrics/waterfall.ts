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
  /** Root spans (no parent in the trace), ordered by start then sequence. */
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
  // Diagnostics span entries (`@dudousxd/nestjs-diagnostics-telescope`) carry the
  // emitting lib + event name, e.g. `agent` + `llm.turn` → "agent:llm.turn".
  if (typeof record.lib === 'string' && typeof record.event === 'string') {
    return `${record.lib}:${record.event}`;
  }
  if (typeof record.name === 'string') return record.name;
  return entry.type;
}

/** The parent span id an entry names (span entries carry `content.parentSpanId`), or null. */
function parentSpanIdOf(entry: Entry): string | null {
  const parent = asRecord(entry.content)?.parentSpanId;
  return typeof parent === 'string' && parent.length > 0 ? parent : null;
}

/**
 * Reconstruct a nested span waterfall from a batch/trace's entries.
 *
 * An entry that names its parent span (`content.parentSpanId`, as the OpenTelemetry span
 * processor's `span` entries do) nests under the entry with that `spanId` when it is in the
 * trace. Every other entry nests by **time-interval containment**, as Sentry/Tempo do when
 * parent links are missing: under the tightest enclosing span whose `[start, end]` strictly
 * contains it, with `sequence` as a stable tie-break for spans that start at the same instant.
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

  const nodes = new Map<Interval, WaterfallSpan>();
  for (const interval of ordered) {
    nodes.set(interval, {
      id: interval.entry.id,
      type: interval.entry.type,
      label: labelFor(interval.entry),
      offsetMs: interval.startMs - traceStartMs,
      durationMs: interval.durationMs,
      depth: 0,
      sequence: interval.entry.sequence,
      children: [],
    });
  }

  // Explicit links first: span id -> the entry carrying it.
  const bySpanId = new Map<string, Interval>();
  for (const interval of ordered) {
    const spanId = interval.entry.spanId;
    if (spanId !== null && spanId !== undefined && !bySpanId.has(spanId)) {
      bySpanId.set(spanId, interval);
    }
  }
  const parentOf = new Map<Interval, Interval>();
  for (const interval of ordered) {
    const parentSpanId = parentSpanIdOf(interval.entry);
    const parent = parentSpanId === null ? undefined : bySpanId.get(parentSpanId);
    if (parent !== undefined && parent !== interval) parentOf.set(interval, parent);
  }
  // A cycle of explicit links (corrupt data) is broken by dropping the link that closes it.
  for (const interval of ordered) {
    const seen = new Set<Interval>([interval]);
    let cursor = parentOf.get(interval);
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        parentOf.delete(interval);
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }

  /** Whether `candidate` is `interval` or below it through the links set so far. */
  const isWithin = (candidate: Interval, interval: Interval): boolean => {
    let cursor: Interval | undefined = candidate;
    while (cursor !== undefined) {
      if (cursor === interval) return true;
      cursor = parentOf.get(cursor);
    }
    return false;
  };

  // Containment for the rest. A stack of currently-open ancestors, innermost last: pop those
  // that don't contain the current span, then take the innermost one that isn't the span's
  // own descendant through an explicit link.
  const openStack: Interval[] = [];
  for (const interval of ordered) {
    while (openStack.length > 0) {
      const top = openStack[openStack.length - 1];
      if (top !== undefined && contains(top, interval)) break;
      openStack.pop();
    }
    if (!parentOf.has(interval)) {
      for (let i = openStack.length - 1; i >= 0; i--) {
        const candidate = openStack[i];
        if (candidate !== undefined && !isWithin(candidate, interval)) {
          parentOf.set(interval, candidate);
          break;
        }
      }
    }
    openStack.push(interval);
  }

  const roots: WaterfallSpan[] = [];
  for (const interval of ordered) {
    const node = nodes.get(interval);
    if (node === undefined) continue;
    const parent = parentOf.get(interval);
    const parentNode = parent === undefined ? undefined : nodes.get(parent);
    if (parentNode === undefined) roots.push(node);
    else parentNode.children.push(node);
  }

  // Order children (and roots) by start offset, then sequence, and set depths.
  const byOffset = (a: WaterfallSpan, b: WaterfallSpan): number =>
    a.offsetMs - b.offsetMs || a.sequence - b.sequence;
  roots.sort(byOffset);
  const stack: WaterfallSpan[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    node.children.sort(byOffset);
    for (const child of node.children) {
      child.depth = node.depth + 1;
      stack.push(child);
    }
  }

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
