import { hostname } from 'node:os';
import type {
  ArchiveOptions,
  Duration,
  Entry,
  EntryQuery,
  TagCount,
} from '@dudousxd/nestjs-telescope';
import { durationToMs } from '@dudousxd/nestjs-telescope';
import { DuckDbEngine, type DuckDbEngineOptions } from './duckdb-engine.js';
import { type ColdEngine, HyparquetEngine } from './engine.js';
import { type ColdFilter, lowerBound, toColdFilter, upperBound } from './filter.js';
import {
  DAY_MS,
  HOUR_MS,
  type Partition,
  dayPrefix,
  fileKey,
  floorDay,
  floorHour,
  hourPrefix,
  parseDayPrefix,
  parseFileKey,
  parseTypePrefix,
  typePrefix,
  uuidV7Time,
} from './layout.js';
import {
  type ColdLocation,
  type ColdLocationOptions,
  ObjectGoneError,
  type StoredObject,
  resolveLocation,
} from './location.js';
import { ParquetFileBuilder, encodeFile, newestFirst, oldestFirst, rowToEntry } from './rows.js';

export type ColdEngineOption = 'hyparquet' | { duckdb: DuckDbEngineOptions };

export interface CompactionOptions {
  /** How often compaction runs, at most. Defaults to `'15m'`. */
  every?: Duration;
  /** Size merged files aim for. Defaults to 128. */
  targetFileMb?: number;
  /**
   * How long after an hour ends before it is considered closed and compacted. Must exceed the
   * longest time an entry can wait in the hot tier before being archived. Defaults to `'2h'`.
   */
  closedAfter?: Duration;
  /** Cap on hours merged per run, so one run's work stays bounded. Defaults to 24. */
  maxHoursPerRun?: number;
  /** How far back closed hours are looked for. Defaults to `'7d'`. */
  lookback?: Duration;
}

export interface ColdRetention {
  /** Applies to every type without its own entry in `perType`. Omit to keep such types forever. */
  default?: Duration;
  perType?: Record<string, Duration>;
}

export interface ParquetColdStoreOptions {
  location: ColdLocationOptions;
  /** Defaults to `'hyparquet'` (pure JS). `{ duckdb }` needs the optional `@duckdb/node-api` peer. */
  engine?: ColdEngineOption;
  /** Merge a closed hour's small files into large ones. `false` disables it. */
  compaction?: CompactionOptions | false;
  /**
   * Deletes whole hours once they are older than their type's retention. For S3, a bucket
   * lifecycle rule per `type=<type>/` prefix does the same without Telescope; this option is for
   * directories, or for buckets where lifecycle rules are not an option.
   */
  retention?: ColdRetention;
  /** Rows per row group. Defaults to 10,000. */
  rowGroupSize?: number;
  /** Written into file names so pods never collide. Defaults to the hostname. */
  instanceId?: string;
  /** How many of the newest hours `tags()` counts over. Defaults to 24. */
  tagScanHours?: number;
}

export interface ColdArchiveOptions {
  types: string[];
  /** Defaults to 5,000: large batches keep cold files large and the archiver ahead of writes. */
  batchSize?: number;
  /** Defaults to 20 (100,000 entries per type per prune cycle). */
  maxBatchesPerCycle?: number;
}

/** A batch/point lookup's first pass, before falling back to the whole tier. */
interface Window {
  lower: number;
  upper: number;
}

const LOOKUP_BEFORE_MS = HOUR_MS;
const LOOKUP_AFTER_MS = HOUR_MS;
const BATCH_BEFORE_MS = 5 * 60 * 1000;
const BATCH_AFTER_MS = 6 * HOUR_MS;
const WRITE_CONCURRENCY = 4;

/**
 * The cold tier: Parquet files under `type=<t>/dt=<yyyy-mm-dd>/hour=<hh>/`, one set per pod,
 * append-only. Use it as the `archive` sink (see {@link archive}) and as the `cold` side of
 * `tieredStorage`.
 */
export class ParquetColdStore {
  readonly location: ColdLocation;
  private readonly engine: ColdEngine;
  private readonly rowGroupSize: number;
  private readonly instanceId: string;
  private readonly tagScanHours: number;
  private readonly compaction: Required<CompactionOptions> | null;
  private readonly retention: ColdRetention | undefined;
  private lastMaintenanceMs = Number.NEGATIVE_INFINITY;
  private maintaining: Promise<void> | null = null;

  constructor(options: ParquetColdStoreOptions) {
    this.location = resolveLocation(options.location);
    const engine = options.engine ?? 'hyparquet';
    this.engine =
      engine === 'hyparquet'
        ? new HyparquetEngine(this.location)
        : new DuckDbEngine(this.location, engine.duckdb);
    this.rowGroupSize = options.rowGroupSize ?? 10_000;
    this.instanceId = options.instanceId ?? hostname();
    this.tagScanHours = options.tagScanHours ?? 24;
    this.compaction =
      options.compaction === false
        ? null
        : {
            every: options.compaction?.every ?? '15m',
            targetFileMb: options.compaction?.targetFileMb ?? 128,
            closedAfter: options.compaction?.closedAfter ?? '2h',
            maxHoursPerRun: options.compaction?.maxHoursPerRun ?? 24,
            lookback: options.compaction?.lookback ?? '7d',
          };
    this.retention = options.retention;
    // Parsed now, so a bad duration fails at construction instead of inside the pruner.
    if (this.compaction) {
      durationToMs(this.compaction.every);
      durationToMs(this.compaction.closedAfter);
      durationToMs(this.compaction.lookback);
    }
    for (const value of Object.values(this.retention?.perType ?? {})) durationToMs(value);
    if (this.retention?.default !== undefined) durationToMs(this.retention.default);
  }

  get engineName(): string {
    return this.engine.name;
  }

  /** Fails when the configured engine cannot start — e.g. DuckDB chosen but not installed. */
  async init(): Promise<void> {
    await this.engine.init();
  }

  async close(): Promise<void> {
    await this.maintaining?.catch(() => undefined);
    await this.engine.close();
  }

  /**
   * The `archive` config for `TelescopeModule.forRoot`, with this store as the sink. The pruner
   * deletes hot entries only after `write` resolves, so a failed upload keeps them hot.
   */
  archive(options: ColdArchiveOptions): ArchiveOptions {
    return {
      types: options.types,
      sink: (entries) => this.write(entries),
      batchSize: options.batchSize ?? 5_000,
      maxBatchesPerCycle: options.maxBatchesPerCycle ?? 20,
    };
  }

  /** Writes `entries` as one file per (type, hour), each sorted by `(createdAt, id)`. */
  async write(entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const groups = new Map<string, { partition: Partition; entries: Entry[] }>();
    for (const entry of entries) {
      const partition = { type: entry.type, hourStart: floorHour(entry.createdAt.getTime()) };
      const id = `${partition.type}\u0000${partition.hourStart}`;
      const group = groups.get(id) ?? { partition, entries: [] };
      group.entries.push(entry);
      groups.set(id, group);
    }
    const pending = [...groups.values()];
    const writeOne = async (): Promise<void> => {
      for (let group = pending.shift(); group !== undefined; group = pending.shift()) {
        const sorted = group.entries.sort(oldestFirst);
        await this.location.write(
          fileKey(group.partition, this.instanceId),
          encodeFile(sorted, this.rowGroupSize),
        );
      }
    };
    await Promise.all(Array.from({ length: WRITE_CONCURRENCY }, writeOne));
  }

  /** Matching entries newest first; with `limit`, the newest `limit` of them. */
  async query(query: EntryQuery, limit?: number): Promise<Entry[]> {
    return this.scan(toColdFilter(query), limit);
  }

  async find(id: string): Promise<Entry | null> {
    const filter: ColdFilter = { ids: new Set([id]), omitContent: false };
    const at = uuidV7Time(id);
    if (at !== null) {
      const [hit] = await this.scan(filter, 1, {
        lower: at - LOOKUP_BEFORE_MS,
        upper: at + LOOKUP_AFTER_MS,
      });
      if (hit !== undefined) return hit;
    }
    const [hit] = await this.scan(filter, 1);
    return hit ?? null;
  }

  /**
   * Entries of a batch, by sequence. A UUIDv7 batch id is looked up around its timestamp first;
   * `wholeTierOnMiss: false` stops there, for callers that already found the batch elsewhere and
   * only want what the cold tier adds.
   */
  async batch(batchId: string, options: { wholeTierOnMiss?: boolean } = {}): Promise<Entry[]> {
    const filter: ColdFilter = { batchId, omitContent: false };
    const at = uuidV7Time(batchId);
    let found: Entry[] = [];
    if (at !== null) {
      found = await this.scan(filter, undefined, {
        lower: at - BATCH_BEFORE_MS,
        upper: at + BATCH_AFTER_MS,
      });
    }
    if (found.length === 0 && (at === null || options.wholeTierOnMiss !== false)) {
      found = await this.scan(filter);
    }
    return dedupe(found).sort((a, b) => a.sequence - b.sequence);
  }

  /** Tag counts over the newest `tagScanHours` hours of the tier. */
  async tags(prefix?: string, search?: string): Promise<TagCount[]> {
    const cutoff = floorHour(Date.now()) - (this.tagScanHours - 1) * HOUR_MS;
    const files: StoredObject[] = [];
    for (const type of await this.types()) {
      for (const day of await this.days(type)) {
        if (day + DAY_MS <= cutoff) continue;
        for (const [hourStart, hourFiles] of await this.hours(type, day)) {
          if (hourStart >= cutoff) files.push(...hourFiles);
        }
      }
    }
    const counts = await this.engine.countTags(files, prefix, search);
    return [...counts.entries()].map(([tag, count]) => ({ tag, count }));
  }

  /** Deletes every cold file. */
  async clear(): Promise<void> {
    const listing = await this.location.list('');
    await this.location.remove(listing.objects.map((object) => object.key));
  }

  /**
   * Compaction and retention, if either is due. Meant to run under the prune lease, which is
   * how `tieredStorage` calls it, so one process does it per cycle.
   */
  async maintain(nowMs = Date.now()): Promise<void> {
    if (this.maintaining !== null) return this.maintaining;
    const every = this.compaction ? durationToMs(this.compaction.every) : 15 * 60 * 1000;
    if (nowMs - this.lastMaintenanceMs < every) return;
    if (this.compaction === null && this.retention === undefined) return;
    this.lastMaintenanceMs = nowMs;
    this.maintaining = (async () => {
      if (this.retention !== undefined) await this.expire(nowMs);
      if (this.compaction !== null) await this.compact(nowMs);
    })().finally(() => {
      this.maintaining = null;
    });
    return this.maintaining;
  }

  /** Deletes the hours that are entirely older than their type's retention. */
  async expire(nowMs = Date.now()): Promise<number> {
    const retention = this.retention;
    if (retention === undefined) return 0;
    let removed = 0;
    for (const type of await this.types()) {
      const duration = retention.perType?.[type] ?? retention.default;
      if (duration === undefined) continue;
      const cutoff = nowMs - durationToMs(duration);
      for (const day of await this.days(type)) {
        if (day >= cutoff) continue;
        const keys: string[] = [];
        for (const [hourStart, files] of await this.hours(type, day)) {
          if (hourStart + HOUR_MS <= cutoff) keys.push(...files.map((file) => file.key));
        }
        await this.location.remove(keys);
        removed += keys.length;
      }
    }
    return removed;
  }

  /**
   * Merges each closed hour's small files into files of about `targetFileMb`, oldest rows first,
   * dropping duplicate ids. Inputs are deleted only after every output is written; until then a
   * reader may see a row twice, which reads deduplicate.
   */
  async compact(nowMs = Date.now()): Promise<number> {
    const compaction = this.compaction;
    if (compaction === null) return 0;
    const targetBytes = compaction.targetFileMb * 1024 * 1024;
    const closedBefore = nowMs - durationToMs(compaction.closedAfter);
    const oldest = nowMs - durationToMs(compaction.lookback);
    let merged = 0;
    for (const type of await this.types()) {
      for (const day of (await this.days(type)).reverse()) {
        if (day + DAY_MS <= oldest || day >= closedBefore) continue;
        for (const [hourStart, files] of await this.hours(type, day)) {
          if (merged >= compaction.maxHoursPerRun) return merged;
          if (hourStart + HOUR_MS > closedBefore) continue;
          const small = files.filter((file) => file.size < targetBytes / 2);
          if (small.length < 2) continue;
          await this.mergeFiles({ type, hourStart }, small, targetBytes);
          merged += 1;
        }
      }
    }
    return merged;
  }

  private async mergeFiles(
    partition: Partition,
    files: StoredObject[],
    targetBytes: number,
  ): Promise<void> {
    const reader = new HyparquetEngine(this.location);
    // Each input is sorted, so a k-way merge over one row group per file keeps memory at k row
    // groups plus the output being built, however large the hour is.
    const cursors = await Promise.all(
      files.map(async (file) => ({ groups: await reader.rowGroups(file), rows: [] as Entry[] })),
    );
    const next = async (cursor: (typeof cursors)[number]): Promise<Entry | undefined> => {
      while (cursor.rows.length === 0) {
        const group = cursor.groups.shift();
        if (group === undefined) return undefined;
        const rows = await reader.readRowGroup(group, [
          'id',
          'batch_id',
          'type',
          'family_hash',
          'tags',
          'content',
          'sequence',
          'duration_ms',
          'origin',
          'instance_id',
          'trace_id',
          'span_id',
          'created_at',
        ]);
        cursor.rows = rows.map(rowToEntry).sort(oldestFirst);
      }
      return cursor.rows[0];
    };

    const outputs: Uint8Array[] = [];
    let builder = new ParquetFileBuilder(this.rowGroupSize);
    let lastId: string | null = null;
    let lastAt = Number.NaN;
    let chunk: Entry[] = [];
    while (true) {
      let best: (typeof cursors)[number] | null = null;
      let bestEntry: Entry | undefined;
      for (const cursor of cursors) {
        const head = await next(cursor);
        if (head !== undefined && (bestEntry === undefined || oldestFirst(head, bestEntry) < 0)) {
          best = cursor;
          bestEntry = head;
        }
      }
      if (best === null || bestEntry === undefined) break;
      best.rows.shift();
      if (bestEntry.id === lastId && bestEntry.createdAt.getTime() === lastAt) continue;
      lastId = bestEntry.id;
      lastAt = bestEntry.createdAt.getTime();
      chunk.push(bestEntry);
      if (chunk.length >= this.rowGroupSize) {
        builder.append(chunk);
        chunk = [];
        if (builder.bytes >= targetBytes) {
          outputs.push(builder.finish());
          builder = new ParquetFileBuilder(this.rowGroupSize);
        }
      }
    }
    if (chunk.length > 0) builder.append(chunk);
    if (builder.rows > 0) outputs.push(builder.finish());

    for (const bytes of outputs) {
      await this.location.write(fileKey(partition, this.instanceId), bytes);
    }
    await this.location.remove(files.map((file) => file.key));
  }

  /**
   * The cold read path. Walks partitions newest first — a day at a time across types, then its
   * hours — and stops as soon as the newest `limit` matches are certain: once the `limit`-th
   * match is at or after an hour's end, no older hour can contain anything newer.
   */
  private async scan(filter: ColdFilter, limit?: number, window?: Window): Promise<Entry[]> {
    const upper = Math.min(upperBound(filter), window?.upper ?? Number.POSITIVE_INFINITY);
    const lower = Math.max(lowerBound(filter), window?.lower ?? Number.NEGATIVE_INFINITY);
    if (upper < lower) return [];
    const types = filter.type !== undefined ? [filter.type] : await this.types();

    const daysByType = await Promise.all(
      types.map(async (type) => ({
        type,
        days: (await this.days(type)).filter((day) => day <= upper && day + DAY_MS > lower),
      })),
    );
    const allDays = [...new Set(daysByType.flatMap(({ days }) => days))].sort((a, b) => b - a);

    let results: Entry[] = [];
    const certain = (boundary: number): boolean => {
      if (limit === undefined || results.length < limit) return false;
      results = dedupe(results).sort(newestFirst).slice(0, limit);
      const kth = results[limit - 1];
      return kth !== undefined && kth.createdAt.getTime() >= boundary;
    };

    for (const day of allDays) {
      if (certain(day + DAY_MS)) break;
      const hourFiles = new Map<number, StoredObject[]>();
      await Promise.all(
        daysByType
          .filter(({ days }) => days.includes(day))
          .map(async ({ type }) => {
            for (const [hourStart, files] of await this.hours(type, day)) {
              if (hourStart > upper || hourStart + HOUR_MS <= lower) continue;
              hourFiles.set(hourStart, [...(hourFiles.get(hourStart) ?? []), ...files]);
            }
          }),
      );
      for (const hourStart of [...hourFiles.keys()].sort((a, b) => b - a)) {
        if (certain(hourStart + HOUR_MS)) break;
        const read = await this.readHour(hourStart, hourFiles.get(hourStart) ?? [], filter, limit);
        for (const entry of read) results.push(entry);
      }
    }
    const final = dedupe(results).sort(newestFirst);
    return limit !== undefined ? final.slice(0, limit) : final;
  }

  /** Reads one hour, re-listing it once if compaction removed a file mid-read. */
  private async readHour(
    hourStart: number,
    files: StoredObject[],
    filter: ColdFilter,
    limit: number | undefined,
  ): Promise<Entry[]> {
    try {
      return await this.engine.read(files, filter, limit);
    } catch (error) {
      if (!(error instanceof ObjectGoneError)) throw error;
      const types = [...new Set(files.map((file) => parseFileKey(file.key)?.type))].filter(
        (type): type is string => type !== undefined,
      );
      const fresh: StoredObject[] = [];
      for (const type of types) {
        const listing = await this.location.list(hourPrefix({ type, hourStart }));
        fresh.push(...listing.objects.filter((object) => object.key.endsWith('.parquet')));
      }
      return this.engine.read(fresh, filter, limit);
    }
  }

  private async types(): Promise<string[]> {
    const listing = await this.location.list('', true);
    return listing.prefixes.map(parseTypePrefix).filter((type): type is string => type !== null);
  }

  /** Day starts that hold files for `type`, newest first. */
  private async days(type: string): Promise<number[]> {
    const listing = await this.location.list(typePrefix(type), true);
    return listing.prefixes
      .map(parseDayPrefix)
      .filter((day): day is number => day !== null)
      .sort((a, b) => b - a);
  }

  /** `type`'s files on `day`, grouped by hour start, newest hour first. */
  private async hours(type: string, day: number): Promise<Map<number, StoredObject[]>> {
    const listing = await this.location.list(dayPrefix(type, floorDay(day)));
    const byHour = new Map<number, StoredObject[]>();
    for (const object of listing.objects) {
      const partition = parseFileKey(object.key);
      if (partition === null) continue;
      byHour.set(partition.hourStart, [...(byHour.get(partition.hourStart) ?? []), object]);
    }
    return new Map([...byHour.entries()].sort((a, b) => b[0] - a[0]));
  }
}

/** First occurrence of each id wins: callers order inputs so the preferred copy comes first. */
export function dedupe(entries: Entry[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

export function parquetColdStore(options: ParquetColdStoreOptions): ParquetColdStore {
  return new ParquetColdStore(options);
}
