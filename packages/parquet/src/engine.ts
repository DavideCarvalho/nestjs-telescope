import type { Entry } from '@dudousxd/nestjs-telescope';
import type { AsyncBuffer, FileMetaData, ParquetQueryFilter } from 'hyparquet';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { type ColdFilter, lowerBound, matches, upperBound } from './filter.js';
import type { ColdLocation, StoredObject } from './location.js';
import { type Column, type ParquetRow, newestFirst, rowToEntry } from './rows.js';

/** Reads cold files. Writing and compaction always go through hyparquet-writer. */
export interface ColdEngine {
  readonly name: string;
  init(): Promise<void>;
  /**
   * Rows of `files` that match `filter`, newest first. With `limit`, the result holds at least
   * the newest `limit` matches (all of them when fewer exist); without it, every match.
   */
  read(files: StoredObject[], filter: ColdFilter, limit?: number): Promise<Entry[]>;
  /** Tag occurrence counts over `files`. */
  countTags(files: StoredObject[], prefix?: string, search?: string): Promise<Map<string, number>>;
  close(): Promise<void>;
}

/** Bounded map evicting the least recently used key; file metadata is immutable per key. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }
}

interface RowGroupRef {
  file: StoredObject;
  metadata: FileMetaData;
  rowStart: number;
  rowEnd: number;
  minMs: number;
  maxMs: number;
}

const READ_CONCURRENCY = 4;
const TAIL_WINDOW = 256;

/**
 * Filters that pick out a few rows anywhere in a file. Those go to hyparquet as a pushdown
 * filter, so statistics and bloom filters skip whole row groups.
 */
function selective(filter: ColdFilter): boolean {
  return (
    filter.ids !== undefined ||
    filter.batchId !== undefined ||
    filter.traceId !== undefined ||
    filter.familyHash !== undefined
  );
}

/**
 * The default engine: hyparquet, pure JavaScript. Reads the footer, then only the row groups
 * whose `created_at` statistics overlap the query, newest first, stopping once the newest
 * `limit` matches are certain. Equality predicates go to hyparquet so row groups whose
 * statistics or bloom filters rule them out are never fetched.
 */
export class HyparquetEngine implements ColdEngine {
  readonly name = 'hyparquet';
  private readonly metadata = new LruCache<string, FileMetaData>(4096);

  constructor(private readonly location: ColdLocation) {}

  async init(): Promise<void> {}

  async close(): Promise<void> {}

  buffer(file: StoredObject): AsyncBuffer {
    return {
      byteLength: file.size,
      slice: (start, end) => this.location.read(file.key, start, end ?? file.size),
    };
  }

  async fileMetadata(file: StoredObject): Promise<FileMetaData> {
    const cached = this.metadata.get(file.key);
    if (cached !== undefined) return cached;
    const metadata = await parquetMetadataAsync(this.buffer(file));
    this.metadata.set(file.key, metadata);
    return metadata;
  }

  /** Row groups of `file` with their `created_at` range, in file (ascending time) order. */
  async rowGroups(file: StoredObject): Promise<RowGroupRef[]> {
    const metadata = await this.fileMetadata(file);
    const refs: RowGroupRef[] = [];
    let rowStart = 0;
    for (const group of metadata.row_groups) {
      const rows = Number(group.num_rows);
      const stats = group.columns.find(
        (column) => column.meta_data?.path_in_schema[0] === 'created_at',
      )?.meta_data?.statistics;
      const minMs = toMs(stats?.min_value) ?? Number.NEGATIVE_INFINITY;
      const maxMs = toMs(stats?.max_value) ?? Number.POSITIVE_INFINITY;
      refs.push({ file, metadata, rowStart, rowEnd: rowStart + rows, minMs, maxMs });
      rowStart += rows;
    }
    return refs;
  }

  async readRowGroup(ref: RowGroupRef, columns: readonly Column[], filter?: ParquetQueryFilter) {
    return (await parquetReadObjects({
      file: this.buffer(ref.file),
      metadata: ref.metadata,
      rowStart: ref.rowStart,
      rowEnd: ref.rowEnd,
      columns: [...columns],
      compressors,
      ...(filter !== undefined ? { filter, useBloomFilters: true } : {}),
    })) as ParquetRow[];
  }

  async read(files: StoredObject[], filter: ColdFilter, limit?: number): Promise<Entry[]> {
    const upper = upperBound(filter);
    const lower = lowerBound(filter);
    const groups = (await Promise.all(files.map((file) => this.rowGroups(file))))
      .flat()
      .filter((group) => group.maxMs >= lower && group.minMs <= upper)
      .sort((a, b) => b.maxMs - a.maxMs);
    const columns = readColumns(filter);
    const results: Entry[] = [];
    const collect = (rows: ParquetRow[]): void => {
      for (const row of rows) {
        const content = row.content;
        const entry = rowToEntry(row);
        if (!matches(entry, filter, content)) continue;
        results.push(filter.omitContent ? { ...entry, content: null } : entry);
      }
    };
    /** Whether the newest `limit` matches are already known to be newer than `boundaryMs`. */
    const settled = (boundaryMs: number): boolean => {
      if (limit === undefined || results.length < limit) return false;
      results.sort(newestFirst);
      results.length = limit;
      return (results[limit - 1]?.createdAt.getTime() ?? Number.NEGATIVE_INFINITY) > boundaryMs;
    };

    if (limit !== undefined && !selective(filter)) {
      // A page of a type: rows are sorted, so the newest matches are at the end of each row
      // group, and reading backwards in growing windows decodes a few hundred rows, not 10,000.
      for (const group of groups) {
        if (settled(group.maxMs)) break;
        let end = group.rowEnd;
        let size = Math.max(TAIL_WINDOW, limit + 1);
        while (end > group.rowStart) {
          const start = Math.max(group.rowStart, end - size);
          const rows = await this.readRows(group, start, end, columns);
          collect(rows);
          const first = rows[0]?.created_at;
          // Earlier rows of this group are no newer than the first row just read.
          if (first !== undefined && settled(new Date(first).getTime())) break;
          end = start;
          size *= 2;
        }
      }
    } else {
      const pushdown = pushdownFilter(filter, lower, upper);
      for (let index = 0; index < groups.length; index += READ_CONCURRENCY) {
        const window = groups.slice(index, index + READ_CONCURRENCY);
        // Every remaining group ends no later than the first of this window.
        if (settled(window[0]?.maxMs ?? Number.NEGATIVE_INFINITY)) break;
        const decoded = await Promise.all(
          window.map((group) => this.readRowGroup(group, columns, pushdown)),
        );
        for (const rows of decoded) collect(rows);
      }
    }
    results.sort(newestFirst);
    return limit !== undefined ? results.slice(0, limit) : results;
  }

  private async readRows(
    group: RowGroupRef,
    rowStart: number,
    rowEnd: number,
    columns: readonly Column[],
  ): Promise<ParquetRow[]> {
    return (await parquetReadObjects({
      file: this.buffer(group.file),
      metadata: group.metadata,
      rowStart,
      rowEnd,
      columns: [...columns],
      compressors,
    })) as ParquetRow[];
  }

  async countTags(
    files: StoredObject[],
    prefix?: string,
    search?: string,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const needle = search?.toLowerCase();
    for (const file of files) {
      for (const group of await this.rowGroups(file)) {
        for (const row of await this.readRowGroup(group, ['tags'])) {
          for (const tag of row.tags ?? []) {
            if (prefix !== undefined && !tag.startsWith(prefix)) continue;
            if (needle && !tag.toLowerCase().includes(needle)) continue;
            counts.set(tag, (counts.get(tag) ?? 0) + 1);
          }
        }
      }
    }
    return counts;
  }
}

/** Every column the predicate or the caller needs; `content` only when it is returned or searched. */
export function readColumns(filter: ColdFilter): Column[] {
  const columns: Column[] = [
    'id',
    'batch_id',
    'type',
    'family_hash',
    'tags',
    'sequence',
    'duration_ms',
    'origin',
    'instance_id',
    'trace_id',
    'span_id',
    'created_at',
  ];
  if (!filter.omitContent || filter.search !== undefined) columns.push('content');
  return columns;
}

function pushdownFilter(
  filter: ColdFilter,
  lower: number,
  upper: number,
): ParquetQueryFilter | undefined {
  const clauses: ParquetQueryFilter[] = [];
  if (filter.type !== undefined) clauses.push({ type: { $eq: filter.type } });
  if (filter.batchId !== undefined) clauses.push({ batch_id: { $eq: filter.batchId } });
  if (filter.traceId !== undefined) clauses.push({ trace_id: { $eq: filter.traceId } });
  if (filter.familyHash !== undefined) clauses.push({ family_hash: { $eq: filter.familyHash } });
  if (filter.ids !== undefined) clauses.push({ id: { $in: [...filter.ids] } });
  if (Number.isFinite(upper)) clauses.push({ created_at: { $lte: new Date(upper) } });
  if (Number.isFinite(lower)) clauses.push({ created_at: { $gte: new Date(lower) } });
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function toMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return null;
}
