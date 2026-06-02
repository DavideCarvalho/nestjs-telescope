// packages/core/src/storage/sqlite-storage-provider.ts
import Database from 'better-sqlite3';
import type { Entry } from '../entry/entry.js';
import { isBatchOrigin } from '../entry/entry.js';
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

interface Row {
  id: string;
  batch_id: string;
  type: string;
  family_hash: string | null;
  content: string;
  tags: string;
  sequence: number;
  duration_ms: number | null;
  origin: string;
  instance_id: string;
  created_at: number;
}

/** Default storage provider: embedded SQLite via better-sqlite3, JSON1 for tags. */
export class SqliteStorageProvider implements StorageProvider {
  private readonly db: Database.Database;

  constructor(options: SqliteStorageOptions = {}) {
    this.db = new Database(options.path ?? ':memory:');
    this.db.pragma('journal_mode = WAL');
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
        created_at integer not null
      );
      create index if not exists ix_te_created on telescope_entries (created_at, id);
      create index if not exists ix_te_type_created on telescope_entries (type, created_at);
      create index if not exists ix_te_batch on telescope_entries (batch_id, sequence);
      create index if not exists ix_te_family on telescope_entries (family_hash);
    `);
  }

  close(): void {
    this.db.close();
  }

  async store(entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const insert = this.db.prepare(
      `insert or replace into telescope_entries
       (id, batch_id, type, family_hash, content, tags, sequence, duration_ms, origin, instance_id, created_at)
       values (@id, @batch_id, @type, @family_hash, @content, @tags, @sequence, @duration_ms, @origin, @instance_id, @created_at)`,
    );
    const tx = this.db.transaction((rows: Row[]) => {
      for (const row of rows) insert.run(row);
    });
    tx(entries.map((e) => this.toRow(e)));
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const existing = this.findRow(id);
    if (!existing) return;
    const merged: Entry = { ...this.fromRow(existing), ...patch, id: existing.id };
    await this.store([merged]);
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const row = this.findRow(id);
    if (!row) return null;
    const entry = this.fromRow(row);
    return { ...entry, batch: await this.batch(entry.batchId) };
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

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
    if (query.before !== undefined) {
      where.push('created_at < @before');
      params.before = query.before.getTime();
    }
    if (query.after !== undefined) {
      where.push('created_at > @after');
      params.after = query.after.getTime();
    }
    if (query.tag !== undefined) {
      where.push(
        'exists (select 1 from json_each(telescope_entries.tags) where value = @tag)',
      );
      params.tag = query.tag;
    }

    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    if (cursor) {
      where.push(
        '(created_at < @cCreated or (created_at = @cCreated and id < @cId))',
      );
      params.cCreated = cursor.createdAt;
      params.cId = cursor.id;
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    const whereClause = where.length > 0 ? `where ${where.join(' and ')}` : '';
    const sql = `select * from telescope_entries
      ${whereClause}
      order by created_at desc, id desc limit @limit`;
    params.limit = limit + 1; // fetch one extra to know if there is a next page

    const rows = this.db.prepare(sql).all(params) as Row[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => this.fromRow(row));
    const last = page.at(-1);
    return {
      data: page,
      nextCursor:
        hasMore && last ? this.encodeCursor(last.createdAt.getTime(), last.id) : null,
    };
  }

  async batch(batchId: string): Promise<Entry[]> {
    const rows = this.db
      .prepare(
        'select * from telescope_entries where batch_id = ? order by sequence asc',
      )
      .all(batchId) as Row[];
    return rows.map((row) => this.fromRow(row));
  }

  async tags(prefix?: string): Promise<TagCount[]> {
    const sql =
      prefix !== undefined
        ? `select value as tag, count(*) as count
           from telescope_entries, json_each(telescope_entries.tags)
           where value like @prefix || '%'
           group by value`
        : `select value as tag, count(*) as count
           from telescope_entries, json_each(telescope_entries.tags)
           group by value`;
    const rows = this.db
      .prepare(sql)
      .all(prefix !== undefined ? { prefix } : {}) as { tag: string; count: number }[];
    return rows.map((row) => ({ tag: row.tag, count: row.count }));
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    const cutoff = olderThan.getTime();
    if (keepLast === undefined) {
      return this.db
        .prepare('delete from telescope_entries where created_at < ?')
        .run(cutoff).changes;
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
    this.db.exec('delete from telescope_entries');
  }

  private findRow(id: string): Row | undefined {
    return this.db
      .prepare('select * from telescope_entries where id = ?')
      .get(id) as Row | undefined;
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
      created_at: entry.createdAt.getTime(),
    };
  }

  private fromRow(row: Row): Entry {
    return {
      id: row.id,
      batchId: row.batch_id,
      type: row.type,
      familyHash: row.family_hash,
      content: JSON.parse(row.content) as unknown,
      tags: JSON.parse(row.tags) as string[],
      sequence: row.sequence,
      durationMs: row.duration_ms,
      origin: isBatchOrigin(row.origin) ? row.origin : 'manual',
      instanceId: row.instance_id,
      createdAt: new Date(row.created_at),
    };
  }

  private encodeCursor(createdAt: number, id: string): string {
    return Buffer.from(`${createdAt}:${id}`).toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: number; id: string } | null {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep === -1) return null;
    const createdAt = Number(decoded.slice(0, sep));
    if (Number.isNaN(createdAt)) return null;
    return { createdAt, id: decoded.slice(sep + 1) };
  }
}
