// packages/core/src/storage/sqlite-storage-provider.ts
import Database from 'better-sqlite3';
import type { Entry } from '../entry/entry.js';
import { isBatchOrigin } from '../entry/entry.js';
import type { RollupBucket, RollupDelta, RollupStore } from '../rollup/rollup-store.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { safeJsonParse } from './safe-json.js';
import type {
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
} from './storage-provider.js';

export interface SqliteStorageOptions {
  /** File path or ':memory:'. Defaults to ':memory:'. */
  path?: string;
}

const DEFAULT_LIMIT = 50;

/** Every persisted column EXCEPT `content`, for content-less projection scans. */
const CONTENTLESS_COLUMNS =
  'id, batch_id, type, family_hash, tags, sequence, duration_ms, origin, instance_id, trace_id, span_id, created_at';

interface Row {
  id: string;
  batch_id: string;
  type: string;
  family_hash: string | null;
  /** Undefined on content-less projection scans (omitContent). */
  content?: string;
  tags: string;
  sequence: number;
  duration_ms: number | null;
  origin: string;
  instance_id: string;
  trace_id: string | null;
  span_id: string | null;
  created_at: number;
}

interface RollupRow {
  metric: string;
  bucket_start: number;
  count: number;
  sum: number;
  max: number;
}

/** Default storage provider: embedded SQLite via better-sqlite3, JSON1 for tags. */
export class SqliteStorageProvider implements StorageProvider, RollupStore {
  private readonly db: Database.Database;
  /** Prepared once; reused by store() and update(). */
  private readonly stmtInsert: Database.Statement;
  /** Prepared once; reused by find() and update(). */
  private readonly stmtFindRow: Database.Statement;
  /** Prepared once; reused by batch(). */
  private readonly stmtBatch: Database.Statement;
  /** Prepared once; reused by recordRollups() — additive upsert. */
  private readonly stmtUpsertRollup: Database.Statement;

  constructor(options: SqliteStorageOptions = {}) {
    const path = options.path ?? ':memory:';
    this.db = new Database(path);

    // WAL is only meaningful for file-backed databases; skip for :memory:.
    if (path !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }

    this.db.exec(`
      create table if not exists telescope_entries (
        id text primary key,
        batch_id text not null,
        type text not null,
        family_hash text,
        content text not null,
        tags text not null,
        sequence integer not null,
        duration_ms integer,
        origin text not null,
        instance_id text not null,
        trace_id text,
        span_id text,
        created_at integer not null
      );
      create index if not exists ix_te_created on telescope_entries (created_at, id);
      create index if not exists ix_te_type_created on telescope_entries (type, created_at);
      create index if not exists ix_te_batch on telescope_entries (batch_id, sequence);
      create index if not exists ix_te_family on telescope_entries (family_hash) where family_hash is not null;

      create table if not exists telescope_rollups (
        metric text not null,
        bucket_start integer not null,
        count integer not null,
        sum integer not null,
        max integer not null,
        primary key (metric, bucket_start)
      );
      create index if not exists ix_tr_bucket on telescope_rollups (bucket_start);
    `);

    // Self-heal tables created before trace_id/span_id existed (additive, no migration).
    // On a freshly-created table these columns already exist, so both no-op via the swallow.
    this.ensureColumn('trace_id text');
    this.ensureColumn('span_id text');

    // Prepare hot-path statements once, after schema is guaranteed to exist.
    this.stmtInsert = this.db.prepare(
      `insert or replace into telescope_entries
       (id, batch_id, type, family_hash, content, tags, sequence, duration_ms, origin, instance_id, trace_id, span_id, created_at)
       values (@id, @batch_id, @type, @family_hash, @content, @tags, @sequence, @duration_ms, @origin, @instance_id, @trace_id, @span_id, @created_at)`,
    );
    this.stmtFindRow = this.db.prepare('select * from telescope_entries where id = ?');
    /** Returns all entries in a batch, ordered by sequence ascending. Capped at 1000 rows. */
    this.stmtBatch = this.db.prepare(
      'select * from telescope_entries where batch_id = ? order by sequence asc limit 1000',
    );
    // Additive upsert: accumulate count/sum, keep a running max.
    this.stmtUpsertRollup = this.db.prepare(
      `insert into telescope_rollups (metric, bucket_start, count, sum, max)
       values (@metric, @bucket_start, @count, @sum, @max)
       on conflict(metric, bucket_start) do update set
         count = count + excluded.count,
         sum = sum + excluded.sum,
         max = max(max, excluded.max)`,
    );
  }

  close(): void {
    this.db.close();
  }

  /**
   * Idempotently adds a column to telescope_entries. SQLite has no
   * `add column if not exists`, so we attempt the alter and swallow ONLY the
   * duplicate-column error (the column is already present); anything else re-throws.
   */
  private ensureColumn(ddl: string): void {
    try {
      this.db.exec(`alter table telescope_entries add column ${ddl}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('duplicate column')) throw error;
    }
  }

  async store(entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const tx = this.db.transaction((rows: Row[]) => {
      for (const row of rows) this.stmtInsert.run(row);
    });
    tx(entries.map((e) => this.toRow(e)));
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    // Atomic read-modify-write: the findRow and write happen in a single transaction,
    // eliminating the lost-update window.
    const tx = this.db.transaction(() => {
      const existing = this.stmtFindRow.get(id) as Row | undefined;
      if (!existing) return;
      const merged: Entry = { ...this.fromRow(existing), ...patch, id: existing.id };
      this.stmtInsert.run(this.toRow(merged));
    });
    tx();
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const row = this.stmtFindRow.get(id) as Row | undefined;
    if (!row) return null;
    const entry = this.fromRow(row);
    return { ...entry, batch: await this.batch(entry.batchId) };
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.ids !== undefined) {
      // Empty id set ⇒ no rows. A bare `id in ()` is invalid SQLite, so return early.
      if (query.ids.length === 0) {
        return { data: [], nextCursor: null };
      }
      const placeholders = query.ids.map((_, index) => `@id${index}`);
      where.push(`id in (${placeholders.join(', ')})`);
      query.ids.forEach((id, index) => {
        params[`id${index}`] = id;
      });
    }
    if (query.type !== undefined) {
      where.push('type = @type');
      params.type = query.type;
    }
    if (query.familyHash !== undefined) {
      where.push('family_hash = @familyHash');
      params.familyHash = query.familyHash;
    }
    if (query.batchId !== undefined) {
      where.push('batch_id = @batchId');
      params.batchId = query.batchId;
    }
    if (query.traceId !== undefined) {
      where.push('trace_id = @traceId');
      params.traceId = query.traceId;
    }
    if (query.before !== undefined) {
      where.push('created_at < @before');
      params.before = query.before.getTime();
    }
    if (query.after !== undefined) {
      where.push('created_at > @after');
      params.after = query.after.getTime();
    }
    if (query.tag !== undefined) {
      where.push('exists (select 1 from json_each(telescope_entries.tags) where value = @tag)');
      params.tag = query.tag;
    }
    if (query.search !== undefined) {
      // Free-text scan over the stored content JSON. SQLite LIKE is case-insensitive
      // for ASCII by default. Runs in the WHERE over the `content` column, so it is
      // independent of the omitContent projection.
      where.push("content like '%' || @search || '%'");
      params.search = query.search;
    }

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor) {
      where.push('(created_at < @cCreated or (created_at = @cCreated and id < @cId))');
      params.cCreated = cursor.createdAt;
      params.cId = cursor.id;
    }

    const limit =
      query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0
        ? query.limit
        : DEFAULT_LIMIT;
    const whereClause = where.length > 0 ? `where ${where.join(' and ')}` : '';
    // omitContent: project every column EXCEPT the heavy `content` blob so the
    // primary aggregate scan never reads/parses it.
    const columns = query.omitContent ? CONTENTLESS_COLUMNS : '*';
    const sql = `select ${columns} from telescope_entries
      ${whereClause}
      order by created_at desc, id desc limit @limit`;
    params.limit = limit + 1; // fetch one extra to know if there is a next page

    const rows = this.db.prepare(sql).all(params) as Row[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => this.fromRow(row, query.omitContent === true));
    const last = page.at(-1);
    return {
      data: page,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt.getTime(), last.id) : null,
    };
  }

  /**
   * Returns all entries belonging to `batchId`, sorted by sequence ascending.
   * Capped at 1000 rows to avoid pathological memory loads.
   */
  async batch(batchId: string): Promise<Entry[]> {
    const rows = this.stmtBatch.all(batchId) as Row[];
    return rows.map((row) => this.fromRow(row));
  }

  async tags(prefix?: string): Promise<TagCount[]> {
    const sql =
      prefix !== undefined
        ? `select value as tag, count(*) as count
           from telescope_entries, json_each(telescope_entries.tags)
           where value like @prefix || '%'
           group by value
           order by count desc`
        : `select value as tag, count(*) as count
           from telescope_entries, json_each(telescope_entries.tags)
           group by value
           order by count desc`;
    const rows = this.db.prepare(sql).all(prefix !== undefined ? { prefix } : {}) as {
      tag: string;
      count: number;
    }[];
    return rows.map((row) => ({ tag: row.tag, count: row.count }));
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    const cutoff = olderThan.getTime();
    if (keepLast === undefined) {
      return this.db.prepare('delete from telescope_entries where created_at < ?').run(cutoff)
        .changes;
    }
    // Delete entries older than cutoff, but keep the newest `keepLast` of those old entries.
    return this.db
      .prepare(
        `delete from telescope_entries
         where created_at < @cutoff
           and id not in (
             select id from telescope_entries where created_at < @cutoff
             order by created_at desc, id desc limit @keepLast
           )`,
      )
      .run({ cutoff, keepLast }).changes;
  }

  async clear(): Promise<void> {
    this.db.exec('delete from telescope_entries; delete from telescope_rollups;');
  }

  // ── RollupStore SPI ────────────────────────────────────────────────────────

  async recordRollups(deltas: RollupDelta[]): Promise<void> {
    if (deltas.length === 0) return;
    const tx = this.db.transaction((rows: RollupRow[]) => {
      for (const row of rows) this.stmtUpsertRollup.run(row);
    });
    tx(
      deltas.map((delta) => ({
        metric: delta.metric,
        bucket_start: delta.bucketStart,
        count: delta.count,
        sum: delta.sum,
        max: delta.max,
      })),
    );
  }

  async queryRollups(
    metrics: string[],
    fromBucket: number,
    toBucket: number,
  ): Promise<RollupBucket[]> {
    if (metrics.length === 0) return [];
    const placeholders = metrics.map((_, index) => `@m${index}`);
    const params: Record<string, unknown> = { from: fromBucket, to: toBucket };
    metrics.forEach((metric, index) => {
      params[`m${index}`] = metric;
    });
    const sql = `select metric, bucket_start, count, sum, max
      from telescope_rollups
      where metric in (${placeholders.join(', ')})
        and bucket_start between @from and @to`;
    const rows = this.db.prepare(sql).all(params) as RollupRow[];
    return rows.map((row) => ({
      metric: row.metric,
      bucketStart: row.bucket_start,
      count: row.count,
      sum: row.sum,
      max: row.max,
    }));
  }

  private toRow(entry: Entry): Row {
    return {
      id: entry.id,
      batch_id: entry.batchId,
      type: entry.type,
      family_hash: entry.familyHash,
      content: JSON.stringify(entry.content),
      tags: JSON.stringify(entry.tags),
      sequence: entry.sequence,
      duration_ms: entry.durationMs,
      origin: entry.origin,
      instance_id: entry.instanceId,
      trace_id: entry.traceId,
      span_id: entry.spanId,
      created_at: entry.createdAt.getTime(),
    };
  }

  private fromRow(row: Row, omitContent = false): Entry {
    // When omitContent projected the column away, `row.content` is undefined;
    // skip parsing entirely and hand back null.
    const rawContent =
      omitContent || row.content === undefined ? null : safeJsonParse<unknown>(row.content, {});
    const rawTags = safeJsonParse<unknown>(row.tags, []);
    return {
      id: row.id,
      batchId: row.batch_id,
      type: row.type,
      familyHash: row.family_hash,
      content: rawContent,
      tags: Array.isArray(rawTags) ? (rawTags as string[]) : [],
      sequence: row.sequence,
      durationMs: row.duration_ms,
      origin: isBatchOrigin(row.origin) ? row.origin : 'manual',
      instanceId: row.instance_id,
      traceId: row.trace_id ?? null,
      spanId: row.span_id ?? null,
      createdAt: new Date(row.created_at),
    };
  }
}
