// packages/core/src/config/volume.ts
//
// Volume knobs for the two highest-volume entry types, `query` and `cache`: record fewer of them
// on a busy app without losing the ones that matter. Sampling here keeps or drops a WHOLE trace:
// the decision is a pure function of the trace id (or, without one, of the request/job batch id),
// so a kept request keeps every query and cache hit it made and a dropped one keeps none. Per-trace
// views — the request timeline, the N+1 detector — stay complete for the traces that are kept.
//
// Rates sharing a key make nested decisions: a trace kept at a lower rate is also kept at any
// higher one (the hash is compared against the rate), so `query.sampleRate: 0.1` with
// `cache.hitSampleRate: 0.5` keeps the cache hits of every trace whose queries were kept.
import type { RecordInput } from '../entry/entry.js';
import type { CacheVolumeOptions, QueryVolumeOptions } from './options.js';
import { isErrorEntry } from './sampling.js';

/** FNV-1a over the key, mapped to [0, 1). Stable across processes and restarts. */
export function traceUnit(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * Whether an entry sampled at `rate` is kept: deterministic per `key` (a trace or batch id), a
 * coin flip with `random` when there is no key.
 */
export function keepByTrace(key: string | null, rate: number, random: () => number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return (key === null ? random() : traceUnit(key)) < rate;
}

/** `'keep'`, or why the entry is not recorded: dropped by a sample (`'sampled'`) or an ignore list. */
export type VolumeDecision = 'keep' | 'sampled' | 'ignored';

/** The `query` / `cache` knobs compiled into one decision over a record input. */
export type VolumeFilter = (
  input: RecordInput,
  samplingKey: () => string | null,
  random: () => number,
) => VolumeDecision;

/** The table a statement reads or writes first: `select … from t`, `insert into t`, `update t`, `delete from t`. */
const PRIMARY_TABLE = /^(?:select\b.*?\bfrom|insert\s+into|update|delete\s+from)\s+([^\s(,;]+)/i;

/** A table name without quoting, lowercased: `"public"."Users"` → `public.users`. */
function bareTable(name: string): string {
  return name.replace(/["`[\]]/g, '').toLowerCase();
}

function contentOf(input: RecordInput): Record<string, unknown> | null {
  return typeof input.content === 'object' && input.content !== null
    ? (input.content as Record<string, unknown>)
    : null;
}

/** Copied without the stateful flags: a `g`/`y` RegExp's `test` would resume from `lastIndex`. */
function stateless(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
}

function compileQuery(options: QueryVolumeOptions | undefined): VolumeFilter | null {
  const sampleRate = options?.sampleRate ?? 1;
  const minMs = options?.minMs ?? 0;
  const tables = new Set(
    (options?.ignoreTables ?? []).filter((table) => table.trim() !== '').map(bareTable),
  );
  if (sampleRate >= 1 && minMs <= 0 && tables.size === 0) return null;
  return (input, samplingKey, random) => {
    if (tables.size > 0) {
      const sql = contentOf(input)?.sql;
      const table = typeof sql === 'string' ? PRIMARY_TABLE.exec(sql.trim())?.[1] : undefined;
      if (table !== undefined) {
        const bare = bareTable(table);
        const unqualified = bare.slice(bare.lastIndexOf('.') + 1);
        if (tables.has(bare) || tables.has(unqualified)) return 'ignored';
      }
    }
    if (sampleRate >= 1 && minMs <= 0) return 'keep';
    // Failed and slow queries are what the console is for: never sampled away.
    if (isErrorEntry(input) || input.tags?.includes('slow')) return 'keep';
    // A query with no reported duration (TypeORM's `logQuery`) is never dropped by `minMs`.
    const duration = input.durationMs;
    if (minMs > 0 && typeof duration === 'number' && duration < minMs) return 'sampled';
    return keepByTrace(samplingKey(), sampleRate, random) ? 'keep' : 'sampled';
  };
}

function compileCache(options: CacheVolumeOptions | undefined): VolumeFilter | null {
  const hitSampleRate = options?.hitSampleRate ?? 1;
  const stores = new Set((options?.ignoreStores ?? []).map((store) => store.toLowerCase()));
  const rules = options?.ignoreKeys ?? [];
  // An empty prefix (e.g. an unset env var) would match every key: skipped.
  const prefixes = rules.filter((rule): rule is string => typeof rule === 'string' && rule !== '');
  const patterns = rules.filter((rule): rule is RegExp => rule instanceof RegExp).map(stateless);
  if (hitSampleRate >= 1 && stores.size === 0 && prefixes.length === 0 && patterns.length === 0) {
    return null;
  }
  return (input, samplingKey, random) => {
    const content = contentOf(input);
    if (content === null) return 'keep';
    const { store, key } = content;
    if (stores.size > 0 && typeof store === 'string' && stores.has(store.toLowerCase())) {
      return 'ignored';
    }
    if (typeof key === 'string') {
      for (const prefix of prefixes) if (key.startsWith(prefix)) return 'ignored';
      for (const pattern of patterns) if (pattern.test(key)) return 'ignored';
    }
    // Only hits are sampled: misses, writes, deletes and clears are always recorded.
    if (content.operation === 'get' && content.hit === true) {
      return keepByTrace(samplingKey(), hitSampleRate, random) ? 'keep' : 'sampled';
    }
    return 'keep';
  };
}

/**
 * Compiles the `query` and `cache` knobs into one filter, or `null` when neither drops anything,
 * so the recorder's hot path pays nothing by default. `samplingKey` is only called when a sampling
 * decision is actually needed.
 */
export function compileVolumeFilter(
  query: QueryVolumeOptions | undefined,
  cache: CacheVolumeOptions | undefined,
): VolumeFilter | null {
  const queryFilter = compileQuery(query);
  const cacheFilter = compileCache(cache);
  if (queryFilter === null && cacheFilter === null) return null;
  return (input, samplingKey, random) => {
    if (input.type === 'query') return queryFilter?.(input, samplingKey, random) ?? 'keep';
    if (input.type === 'cache') return cacheFilter?.(input, samplingKey, random) ?? 'keep';
    return 'keep';
  };
}

/** Whether the `query` knobs can sample entries away (not just ignore tables). */
export function querySamplingCanDrop(query: QueryVolumeOptions | undefined): boolean {
  return (query?.sampleRate ?? 1) < 1 || (query?.minMs ?? 0) > 0;
}
