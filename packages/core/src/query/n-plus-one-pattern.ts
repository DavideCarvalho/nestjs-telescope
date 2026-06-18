// packages/core/src/query/n-plus-one-pattern.ts
import { type Entry, EntryType } from '../entry/entry.js';

/**
 * A detected N+1 LOOP pattern within a single batch: one driving "parent" query
 * (the SELECT that produced the rows being iterated) followed by N similarly-
 * shaped "child" queries (the per-row lookups). Richer than the flat
 * {@link detectNPlusOne} family-count: it attributes a likely parent and weights
 * by the total time WASTED in the loop, so the worst offenders rank first.
 */
export interface NPlusOnePattern {
  /** The repeated child query's family hash. */
  childFamilyHash: string;
  /** A representative child SQL (template/text). */
  childSql: string;
  /** How many times the child query ran in the batch (>= threshold). */
  count: number;
  /** Sum of the child queries' durations (ms) — the "wasted" time, the rank key. */
  totalDurationMs: number;
  /**
   * The family hash of the query that most likely drove the loop — the distinct
   * query immediately preceding the loop in record order — or `null` when the
   * loop is the first thing in the batch (no identifiable parent).
   */
  parentFamilyHash: string | null;
  /** The likely-parent SQL, or `null` when there is no identifiable parent. */
  parentSql: string | null;
  /** A representative child entry id (deep-link / hydration seam). */
  representativeId: string;
  /** The batch the pattern was found in. */
  batchId: string;
}

export interface NPlusOnePatternOptions {
  /** Minimum repetitions of one child template to flag a loop. */
  threshold: number;
}

function sqlOf(entry: Entry): string {
  const record =
    typeof entry.content === 'object' && entry.content !== null
      ? (entry.content as Record<string, unknown>)
      : null;
  return record !== null && typeof record.sql === 'string' ? record.sql : '';
}

interface ChildGroup {
  count: number;
  totalDurationMs: number;
  representativeId: string;
  sql: string;
  /** Record-order index of the FIRST occurrence (to find the driving parent). */
  firstIndex: number;
}

/**
 * Detect N+1 loop patterns in a batch's query entries. For each query family that
 * repeats `>= threshold` times, we emit a pattern weighted by the loop's total
 * duration and attribute the likely driving parent (the distinct query that ran
 * just before the loop began). Pure; ordered by total wasted duration desc.
 *
 * DESIGN: the flat {@link detectNPlusOne} only answers "did family X repeat N
 * times". This adds the two things that make an N+1 actionable — *which* query
 * caused it, and *how much time* it cost — modelled on how Sentry/Laravel
 * surface N+1: the loop body plus the originating parent span, ranked by cost.
 */
export function detectNPlusOnePatterns(
  entries: Entry[],
  options: NPlusOnePatternOptions,
): NPlusOnePattern[] {
  const queries = entries.filter(
    (entry) => entry.type === EntryType.Query && entry.familyHash !== null,
  );

  const groups = new Map<string, ChildGroup>();
  queries.forEach((entry, index) => {
    const familyHash = entry.familyHash as string;
    const duration = typeof entry.durationMs === 'number' ? entry.durationMs : 0;
    const existing = groups.get(familyHash);
    if (existing) {
      existing.count += 1;
      existing.totalDurationMs += duration;
    } else {
      groups.set(familyHash, {
        count: 1,
        totalDurationMs: duration,
        representativeId: entry.id,
        sql: sqlOf(entry),
        firstIndex: index,
      });
    }
  });

  const patterns: NPlusOnePattern[] = [];
  for (const [childFamilyHash, group] of groups) {
    if (group.count < options.threshold) continue;
    const parent = findParent(queries, group.firstIndex, childFamilyHash);
    patterns.push({
      childFamilyHash,
      childSql: group.sql,
      count: group.count,
      totalDurationMs: group.totalDurationMs,
      parentFamilyHash: parent?.familyHash ?? null,
      parentSql: parent === null ? null : sqlOf(parent),
      representativeId: group.representativeId,
      batchId: queries[group.firstIndex]?.batchId ?? '',
    });
  }

  return patterns.sort(
    (a, b) =>
      b.totalDurationMs - a.totalDurationMs ||
      b.count - a.count ||
      a.childFamilyHash.localeCompare(b.childFamilyHash),
  );
}

/**
 * The likely driving parent for a loop whose first child is at `firstIndex`:
 * walking BACKWARDS from just before the loop, the first query of a DIFFERENT
 * family. Returns `null` when none precedes it (the loop is the batch's start).
 */
function findParent(queries: Entry[], firstIndex: number, childFamilyHash: string): Entry | null {
  for (let i = firstIndex - 1; i >= 0; i--) {
    const candidate = queries[i];
    if (candidate !== undefined && candidate.familyHash !== childFamilyHash) {
      return candidate;
    }
  }
  return null;
}

/** The content shape of a synthetic N+1 insight entry (see {@link toSyntheticInsightEntry}). */
export interface NPlusOneInsightContent {
  kind: 'n-plus-one';
  childSql: string;
  parentSql: string | null;
  count: number;
  totalDurationMs: number;
  message: string;
}

/**
 * Convert a detected pattern into a SYNTHETIC insight entry so the loop surfaces
 * in the same entry stream as everything else (deep-linked to its batch). It is
 * NOT a captured event — `id` is derived deterministically from the batch +
 * child family so re-running detection over the same batch yields a stable id
 * (idempotent ingestion). Carries the `n-plus-one` + `insight` tags for filtering.
 */
export function toSyntheticInsightEntry(
  pattern: NPlusOnePattern,
  at: Date = new Date(),
): Entry<NPlusOneInsightContent> {
  const message =
    pattern.parentSql !== null
      ? `N+1: ${pattern.count} repeats of a child query driven by "${pattern.parentSql}" (~${Math.round(pattern.totalDurationMs)}ms)`
      : `N+1: ${pattern.count} repeats of a similar query (~${Math.round(pattern.totalDurationMs)}ms)`;
  return {
    id: `insight:n+1:${pattern.batchId}:${pattern.childFamilyHash}`,
    batchId: pattern.batchId,
    type: 'insight',
    familyHash: `n-plus-one:${pattern.childFamilyHash}`,
    content: {
      kind: 'n-plus-one',
      childSql: pattern.childSql,
      parentSql: pattern.parentSql,
      count: pattern.count,
      totalDurationMs: pattern.totalDurationMs,
      message,
    },
    tags: ['insight', 'n-plus-one'],
    sequence: 0,
    durationMs: pattern.totalDurationMs,
    origin: 'manual',
    instanceId: '',
    traceId: null,
    spanId: null,
    createdAt: at,
  };
}
