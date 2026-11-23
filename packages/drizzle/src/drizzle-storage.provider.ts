// packages/drizzle/src/drizzle-storage.provider.ts
//
// A StorageProvider that persists Telescope entries to PostgreSQL through Drizzle ORM
// (`drizzle-orm/node-postgres`).
//
// Connections:
//
//  - Handed the host's `NodePgDatabase` (or a `pg` Pool), the provider BORROWS that pool and wraps
//    it in its OWN Drizzle instance, built without a logger. Drizzle keeps the logger on the
//    instance, not on the pool, so the host's query logger (Telescope's included) never sees the
//    provider's statements: no `INSERT INTO telescope_entries` is captured as a query, flushed,
//    and captured again. A borrowed pool is never closed by the provider.
//  - With `dedicatedPool`, or when the host's client is a single `pg.Client` rather than a Pool
//    (a shared client cannot run the provider's transactions next to the host's), the provider
//    opens its own Pool with the host's connection settings (`pickHostConnection`) and closes it at
//    shutdown. Handed `PoolConfig` options, it does the same with those.
//
// Boot: `init()` runs the additive boot DDL behind a fingerprint gate when `ensureSchema` is on
// (see boot-ddl.ts). A host that creates the tables with drizzle-kit from the exported schema
// turns it off.
//
// Reads use keyset pagination: newest first (`created_at DESC, id DESC`), and a cursor is a
// `(createdAt, id)` POSITION, so paging resumes even after the cursor's entry was pruned. Tag
// filters run against the space-padded `tags_text` column with `LIKE '% <tag> %'`, like the
// MikroORM provider, so the leading and trailing spaces keep `slow` from matching `slowest`.
import type {
  BoundedPruneCapable,
  BoundedPruneResult,
  BoundedPruneScope,
  Entry,
  EntryAggregateResult,
  EntryAggregation,
  EntryQuery,
  EntryWithBatch,
  LeaseCapableStorage,
  Page,
  PruneScope,
  RollupBucket,
  RollupDelta,
  RollupStore,
  TagCount,
  TagQuery,
} from '@dudousxd/nestjs-telescope';
import {
  HISTOGRAM_BUCKET_COUNT,
  decodeCursor,
  encodeCursor,
  isBatchOrigin,
  mergeHistograms,
  normalizeHistogram,
} from '@dudousxd/nestjs-telescope';
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  like,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { aggregateSql, numbered } from './aggregate-sql.js';
import { qualified, reconcileSchema } from './boot-ddl.js';
import { OVERVIEW_INDEX_NAMES, overviewIndexStatements } from './overview-indexes.js';
import { TELESCOPE_TABLES, type TelescopeTables, telescopeTables } from './schema.js';

const DEFAULT_LIMIT = 50;

/**
 * Rows per INSERT. Fourteen columns each, so 500 rows bind 7,000 parameters: well under
 * PostgreSQL's 65,535 even for a host that raises the recorder's flush size.
 */
const DEFAULT_BATCH_SIZE = 500;

/** Connections in a pool the provider opens itself, unless `dedicatedPool.max` says otherwise. */
const DEDICATED_POOL_MAX = 4;

/** Buckets per rollup upsert statement (6 bound values each). */
const ROLLUP_UPSERT_CHUNK = 100;

/** What the provider can be handed: the host's Drizzle database, a `pg` Pool, or Pool options. */
// biome-ignore lint/suspicious/noExplicitAny: the host's schema type is irrelevant here.
export type DrizzleStorageSource = NodePgDatabase<any> | pg.Pool | pg.PoolConfig;

export interface DrizzleStorageProviderSettings {
  /**
   * Create and heal the tables at boot (default `true`). Turn it off when your own drizzle-kit
   * migrations create them from the exported schema.
   */
  ensureSchema?: boolean;
  /**
   * A PostgreSQL schema for every Telescope table, written into each statement (Telescope never
   * sets `search_path`). Created at boot when missing and `ensureSchema` is on.
   */
  schema?: string;
  /**
   * Open a pool of the provider's own with the host's connection settings instead of borrowing
   * the host's pool. `max` sets its size (default 4).
   */
  dedicatedPool?: boolean | { max?: number };
  /** Rows per INSERT statement (default 500). */
  batchSize?: number;
}

/** The host's client, as Drizzle's node-postgres driver keeps it on `$client`. */
type PgClientLike = pg.Pool | pg.PoolClient | pg.Client;

function isPool(value: unknown): value is pg.Pool {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as pg.Pool).connect === 'function' &&
    typeof (value as pg.Pool).query === 'function' &&
    typeof (value as pg.Pool).totalCount === 'number'
  );
}

function isDrizzleDatabase(value: unknown): value is { $client: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$client' in value &&
    typeof (value as { select?: unknown }).select === 'function'
  );
}

/** Pool options that only describe where and how to connect, from a `pg` Pool or Client. */
const CONNECTION_KEYS = [
  'connectionString',
  'host',
  'port',
  'user',
  'password',
  'database',
  'ssl',
  'options',
  'application_name',
  'keepAlive',
  'keepAliveInitialDelayMillis',
  'statement_timeout',
  'query_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
  'connectionTimeoutMillis',
  'idleTimeoutMillis',
  'client_encoding',
  'types',
] as const;

/**
 * The connection settings of the host's `pg` Pool (its `options`) or Client (its own fields), for
 * a pool the provider opens itself. Copies only what says where and how to connect: never the
 * pool size, `log`, or event wiring.
 */
export function pickHostConnection(client: PgClientLike): pg.PoolConfig {
  // Read key by key, never spread: `pg` keeps `password` non-enumerable on a Client, its
  // connection parameters and a Pool's options.
  const sources: Array<Record<string, unknown>> = isPool(client)
    ? [(client as pg.Pool & { options?: Record<string, unknown> }).options ?? {}]
    : [
        client as unknown as Record<string, unknown>,
        (client as { connectionParameters?: Record<string, unknown> }).connectionParameters ?? {},
      ];
  const picked: Record<string, unknown> = {};
  for (const key of CONNECTION_KEYS) {
    for (const source of sources) {
      const value = source[key];
      if (value !== undefined && value !== null) {
        picked[key] = value;
        break;
      }
    }
  }
  return picked as pg.PoolConfig;
}

function padTags(tags: string[]): string {
  return tags.length ? ` ${tags.join(' ')} ` : ' ';
}

/** JSON `null` for a null or absent content: the column is NOT NULL, and SQL NULL is not JSON. */
function contentValue(content: unknown): unknown {
  return content === null || content === undefined ? sql`'null'::jsonb` : content;
}

interface RowLike {
  id: string;
  batchId: string;
  type: string;
  familyHash: string | null;
  content?: unknown;
  tags: string[];
  sequence: number;
  durationMs: number | null;
  origin: string;
  instanceId: string;
  traceId: string | null;
  spanId: string | null;
  createdAt: Date;
}

function rowToEntry(row: RowLike, omitContent = false): Entry {
  return {
    id: row.id,
    batchId: row.batchId,
    type: row.type,
    familyHash: row.familyHash,
    content: omitContent ? null : (row.content ?? null),
    tags: row.tags,
    sequence: row.sequence,
    durationMs: row.durationMs,
    origin: isBatchOrigin(row.origin) ? row.origin : 'manual',
    instanceId: row.instanceId,
    traceId: row.traceId ?? null,
    spanId: row.spanId ?? null,
    createdAt: row.createdAt,
  };
}

function resolveLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
}

/**
 * Declared against {@link BoundedPruneCapable}, {@link LeaseCapableStorage} and
 * {@link RollupStore}, so dropping a capability is a compile error rather than a silent fallback
 * to unbounded, unlocked pruning or raw-scan rollups.
 */
export class DrizzleStorageProvider
  implements BoundedPruneCapable, LeaseCapableStorage, RollupStore
{
  private readonly source: DrizzleStorageSource;
  private readonly ensureSchema: boolean;
  private readonly schema: string | undefined;
  private readonly dedicated: boolean | { max?: number };
  private readonly batchSize: number;
  private readonly tables: TelescopeTables;
  private pool: pg.Pool | null = null;
  private ownsPool = false;
  // biome-ignore lint/suspicious/noExplicitAny: the provider's own instance has no relational schema.
  private db: NodePgDatabase<any> | null = null;
  /** `server_version_num`, read once, on the first aggregation. */
  private postgresVersion: number | null = null;

  constructor(source: DrizzleStorageSource, settings: DrizzleStorageProviderSettings = {}) {
    this.source = source;
    this.ensureSchema = settings.ensureSchema ?? true;
    this.schema =
      settings.schema !== undefined && settings.schema !== '' ? settings.schema : undefined;
    this.dedicated = settings.dedicatedPool ?? false;
    this.batchSize =
      settings.batchSize !== undefined &&
      Number.isInteger(settings.batchSize) &&
      settings.batchSize > 0
        ? settings.batchSize
        : DEFAULT_BATCH_SIZE;
    this.tables = telescopeTables(this.schema);
  }

  /** The pool the provider uses, and whether it opened it (and so must close it). */
  private resolvePool(): { pool: pg.Pool; owned: boolean } {
    const max =
      typeof this.dedicated === 'object' && this.dedicated.max !== undefined
        ? this.dedicated.max
        : DEDICATED_POOL_MAX;
    const client: unknown = isDrizzleDatabase(this.source) ? this.source.$client : this.source;
    if (isPool(client) && this.dedicated === false) return { pool: client, owned: false };
    if (isPool(client) || isDrizzleDatabase(this.source)) {
      return {
        pool: new pg.Pool({ ...pickHostConnection(client as PgClientLike), max }),
        owned: true,
      };
    }
    return { pool: new pg.Pool({ max, ...(this.source as pg.PoolConfig) }), owned: true };
  }

  async init(): Promise<void> {
    if (this.db) return;
    const { pool, owned } = this.resolvePool();
    this.pool = pool;
    this.ownsPool = owned;
    this.db = drizzle({ client: pool });
    if (this.ensureSchema) await reconcileSchema(pool, this.schema);
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.db = null;
    this.pool = null;
    if (pool && this.ownsPool) await pool.end();
  }

  // biome-ignore lint/suspicious/noExplicitAny: see `db`.
  private database(): NodePgDatabase<any> {
    if (!this.db) throw new Error('DrizzleStorageProvider: init() must run before use');
    return this.db;
  }

  private rawPool(): pg.Pool {
    if (!this.pool) throw new Error('DrizzleStorageProvider: init() must run before use');
    return this.pool;
  }

  private toRow(entry: Entry) {
    return {
      id: entry.id,
      batchId: entry.batchId,
      type: entry.type,
      familyHash: entry.familyHash,
      content: contentValue(entry.content),
      tags: entry.tags,
      tagsText: padTags(entry.tags),
      sequence: entry.sequence,
      durationMs: entry.durationMs,
      origin: entry.origin,
      instanceId: entry.instanceId,
      traceId: entry.traceId ?? null,
      spanId: entry.spanId ?? null,
      createdAt: entry.createdAt,
    };
  }

  /**
   * Plain multi-row INSERTs, `batchSize` rows each. A flush spanning several statements runs in one
   * transaction, so it lands whole or not at all, and the recorder's retry never re-inserts rows
   * a failed attempt wrote.
   */
  async store(entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const db = this.database();
    const { entries: table } = this.tables;
    const rows = entries.map((entry) => this.toRow(entry));
    if (rows.length <= this.batchSize) {
      await db.insert(table).values(rows);
      return;
    }
    await db.transaction(async (tx) => {
      for (let offset = 0; offset < rows.length; offset += this.batchSize) {
        await tx.insert(table).values(rows.slice(offset, offset + this.batchSize));
      }
    });
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const { id: _ignoredId, ...rest } = patch;
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      set[key] = key === 'content' ? contentValue(value) : value;
    }
    if (rest.tags !== undefined) set.tagsText = padTags(rest.tags);
    if (Object.keys(set).length === 0) return;
    const { entries: table } = this.tables;
    await this.database().update(table).set(set).where(eq(table.id, id));
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const { entries: table } = this.tables;
    const [row] = await this.database().select().from(table).where(eq(table.id, id)).limit(1);
    if (!row) return null;
    const batch = await this.batch(row.batchId);
    return { ...rowToEntry(row), batch };
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    const { entries: table } = this.tables;
    if (query.ids !== undefined && query.ids.length === 0) return { data: [], nextCursor: null };

    const where: SQL[] = [];
    if (query.ids !== undefined) where.push(inArray(table.id, query.ids));
    // Presence, not truthiness: an explicit empty-string filter still applies.
    if (query.type !== undefined) where.push(eq(table.type, query.type));
    if (query.familyHash !== undefined) where.push(eq(table.familyHash, query.familyHash));
    if (query.batchId !== undefined) where.push(eq(table.batchId, query.batchId));
    if (query.traceId !== undefined) where.push(eq(table.traceId, query.traceId));
    if (query.tag !== undefined) where.push(like(table.tagsText, `% ${query.tag} %`));
    if (query.after) where.push(gt(table.createdAt, query.after));
    if (query.before) where.push(lt(table.createdAt, query.before));

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor) {
      const at = new Date(cursor.createdAt);
      const older = or(
        lt(table.createdAt, at),
        and(eq(table.createdAt, at), lt(table.id, cursor.id)),
      );
      if (older) where.push(older);
    }
    // Case-insensitive substring of the stored content's text form, ANDed with every other filter.
    // It reads the column in SQL, so it is independent of the omitContent projection.
    if (query.search !== undefined) {
      where.push(ilike(sql`${table.content}::text`, `%${query.search}%`));
    }

    const limit = resolveLimit(query.limit);
    const db = this.database();
    const columns = {
      id: table.id,
      batchId: table.batchId,
      type: table.type,
      familyHash: table.familyHash,
      tags: table.tags,
      sequence: table.sequence,
      durationMs: table.durationMs,
      origin: table.origin,
      instanceId: table.instanceId,
      traceId: table.traceId,
      spanId: table.spanId,
      createdAt: table.createdAt,
    };
    // omitContent: the heavy content column is never selected.
    const selection = query.omitContent ? columns : { ...columns, content: table.content };
    const rows: RowLike[] = await db
      .select(selection)
      .from(table)
      .where(and(...where))
      .orderBy(desc(table.createdAt), desc(table.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const last = slice.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt.getTime(), last.id) : null;
    return { data: slice.map((row) => rowToEntry(row, query.omitContent === true)), nextCursor };
  }

  async batch(batchId: string): Promise<Entry[]> {
    const { entries: table } = this.tables;
    const rows = await this.database()
      .select()
      .from(table)
      .where(eq(table.batchId, batchId))
      .orderBy(asc(table.sequence));
    return rows.map((row) => rowToEntry(row));
  }

  async tags(prefix?: string, query?: TagQuery): Promise<TagCount[]> {
    const { entries: table } = this.tables;
    const rows = await this.database()
      .select({ tags: table.tags })
      .from(table)
      .orderBy(desc(table.createdAt), desc(table.id))
      // The newest 10 000 rows at most; fewer when the caller asks for fewer (`recent`).
      .limit(query?.recent !== undefined ? Math.max(0, Math.min(10000, query.recent)) : 10000);

    const search = query?.search?.trim().toLowerCase();
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags) {
        if (prefix && !tag.startsWith(prefix)) continue;
        if (search && !tag.toLowerCase().includes(search)) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    // Count descending, ties by tag: the total order `offset` pages over.
    const ordered = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    if (query?.limit === undefined) return ordered;
    const offset = query.offset ?? 0;
    return ordered.slice(offset, offset + query.limit);
  }

  /** `created_at < before` and the type selector: one type, all but some, or every type. */
  private scopedWhere(scope: { before: Date; type?: string; excludeTypes?: string[] }): SQL {
    const { entries: table } = this.tables;
    const where: SQL[] = [lt(table.createdAt, scope.before)];
    if (scope.type !== undefined) {
      where.push(eq(table.type, scope.type));
    } else if (scope.excludeTypes !== undefined && scope.excludeTypes.length > 0) {
      where.push(notInArray(table.type, scope.excludeTypes));
    }
    return and(...where) as SQL;
  }

  /**
   * Deletes what `where` matches, sparing the newest `keepLast` of it. The spared rows are skipped
   * in a subquery (`OFFSET keepLast`), so the ids to delete never travel to Node.
   */
  private async deleteWhere(where: SQL, keepLast?: number): Promise<number> {
    const db = this.database();
    const { entries: table } = this.tables;
    if (keepLast === undefined) {
      return (await db.delete(table).where(where)).rowCount ?? 0;
    }
    const doomed = db
      .select({ id: table.id })
      .from(table)
      .where(where)
      .orderBy(desc(table.createdAt), desc(table.id))
      .offset(Math.max(0, keepLast));
    return (await db.delete(table).where(inArray(table.id, doomed))).rowCount ?? 0;
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    return this.deleteWhere(this.scopedWhere({ before: olderThan }), keepLast);
  }

  async pruneScoped(input: PruneScope): Promise<number> {
    return this.deleteWhere(this.scopedWhere(input), input.keepLast);
  }

  /**
   * The oldest `limit` rows of `where`: their ids are SELECTED, then deleted by primary key, each
   * call its own statement (and so its own short transaction). With a `type = ?` filter the read
   * is a range of the `(type, created_at, id)` index in the ORDER BY's order.
   *
   * `hasMore` comes from what was selected, not from what was deleted: a racing pruner can delete
   * some of these rows first, which says nothing about whether work remains.
   */
  private async pruneOldestBatch(where: SQL, limit: number): Promise<BoundedPruneResult> {
    const db = this.database();
    const { entries: table } = this.tables;
    const doomed = await db
      .select({ id: table.id })
      .from(table)
      .where(where)
      .orderBy(asc(table.createdAt), asc(table.id))
      .limit(limit);
    if (doomed.length === 0) return { deleted: 0, hasMore: false };
    const result = await db.delete(table).where(
      inArray(
        table.id,
        doomed.map((row) => row.id),
      ),
    );
    return { deleted: result.rowCount ?? 0, hasMore: doomed.length === limit };
  }

  /**
   * Every `type` present, one index seek each (`type > ?`, first in order): a skip scan by hand,
   * since a plain DISTINCT reads the whole index before PostgreSQL 18.
   */
  private async distinctTypes(): Promise<string[]> {
    const db = this.database();
    const { entries: table } = this.tables;
    const types: string[] = [];
    for (;;) {
      const previous = types[types.length - 1];
      const [next] = await db
        .select({ type: table.type })
        .from(table)
        .where(previous === undefined ? undefined : gt(table.type, previous))
        .orderBy(asc(table.type))
        .limit(1);
      if (!next) return types;
      types.push(next.type);
    }
  }

  async pruneScopedBatch(input: BoundedPruneScope): Promise<BoundedPruneResult> {
    if (input.type !== undefined || !input.excludeTypes?.length) {
      return this.pruneOldestBatch(this.scopedWhere(input), input.limit);
    }
    // All types but some, one type at a time: as one `type NOT IN (...)` read the planner walks
    // the `created_at` index past every kept row of the excluded types, which are excluded because
    // they are kept longer and so usually hold most of the table.
    const excluded = new Set(input.excludeTypes);
    let deleted = 0;
    for (const type of await this.distinctTypes()) {
      if (excluded.has(type)) continue;
      const batch = await this.pruneOldestBatch(
        this.scopedWhere({ before: input.before, type }),
        input.limit - deleted,
      );
      deleted += batch.deleted;
      if (batch.hasMore) return { deleted, hasMore: true };
    }
    return { deleted, hasMore: false };
  }

  /**
   * One atomic statement: insert the lease, or take over the existing row only when it has expired
   * or this owner already holds it. The row comes back exactly when the lease was granted; two
   * racing pods meet on the primary key and only one matches.
   */
  async tryAcquireLease(
    key: string,
    owner: string,
    ttlMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const { leases: table } = this.tables;
    const granted = await this.database()
      .insert(table)
      .values({ key, owner, expiresAt: nowMs + ttlMs })
      .onConflictDoUpdate({
        target: table.key,
        set: { owner, expiresAt: nowMs + ttlMs },
        setWhere: or(lte(table.expiresAt, nowMs), eq(table.owner, owner)) as SQL,
      })
      .returning({ key: table.key });
    return granted.length > 0;
  }

  async releaseLease(key: string, owner: string): Promise<void> {
    const { leases: table } = this.tables;
    // Owner-scoped: a holder whose lease expired and was re-granted must not delete the new row.
    await this.database()
      .delete(table)
      .where(and(eq(table.key, key), eq(table.owner, owner)));
  }

  async clear(): Promise<void> {
    const db = this.database();
    await db.delete(this.tables.entries);
    await db.delete(this.tables.rollups);
  }

  /**
   * Creates the opt-in indexes the console's Overview and Pulse read through (see
   * {@link overviewIndexStatements}), skipping those that exist. Run it once, from a migration or
   * a one-off script, never on every boot: the indexes build `CONCURRENTLY` (writes go on) and add
   * about half to the size of the table's indexes. Returns the names it created; a run that
   * creates none changes nothing.
   */
  async createOverviewIndexes(): Promise<string[]> {
    await this.init();
    const pool = this.rawPool();
    const existing = new Set(
      (
        await pool.query<{ name: string }>(
          'select indexname as name from pg_indexes where tablename = $1 and schemaname = coalesce($2, current_schema())',
          [TELESCOPE_TABLES.entries, this.schema ?? null],
        )
      ).rows.map((row) => row.name),
    );
    const created: string[] = [];
    for (const statement of overviewIndexStatements(
      this.schema !== undefined ? { schema: this.schema } : {},
    )) {
      const name = OVERVIEW_INDEX_NAMES.find((candidate) => statement.includes(candidate));
      // The autovacuum setting is applied with the indexes it serves: a run that creates nothing
      // changes nothing.
      if (name === undefined ? created.length === 0 : existing.has(name)) continue;
      await pool.query(statement);
      if (name !== undefined) created.push(name);
    }
    return created;
  }

  // ── RollupStore SPI ────────────────────────────────────────────────────────

  /**
   * Additively merges deltas into `telescope_rollups` with one `INSERT ... ON CONFLICT DO UPDATE`
   * per 100 buckets: count and sum add, max keeps the larger value and the histogram adds cell by
   * cell, all against the row as stored at write time, so pods writing the same minute never lose
   * each other's increments. Buckets go in key order, so concurrent writers lock rows in the same
   * order.
   */
  async recordRollups(deltas: RollupDelta[]): Promise<void> {
    if (deltas.length === 0) return;
    const pool = this.rawPool();
    const buckets = mergeDeltasByBucket(deltas);
    const table = qualified(TELESCOPE_TABLES.rollups, this.schema);
    for (let offset = 0; offset < buckets.length; offset += ROLLUP_UPSERT_CHUNK) {
      const chunk = buckets.slice(offset, offset + ROLLUP_UPSERT_CHUNK);
      await pool.query(
        rollupUpsertSql(table, chunk.length),
        chunk.flatMap((delta) => [
          delta.metric,
          delta.bucketStart,
          delta.count,
          delta.sum,
          delta.max,
          JSON.stringify(normalizeHistogram(delta.histogram)),
        ]),
      );
    }
  }

  async queryRollups(
    metrics: string[],
    fromBucket: number,
    toBucket: number,
  ): Promise<RollupBucket[]> {
    if (metrics.length === 0) return [];
    const { rollups: table } = this.tables;
    const rows = await this.database()
      .select()
      .from(table)
      .where(
        and(
          inArray(table.metric, metrics),
          gte(table.bucketStart, fromBucket),
          lte(table.bucketStart, toBucket),
        ),
      );
    return rows.map((row) => ({
      metric: row.metric,
      bucketStart: row.bucketStart,
      count: row.count,
      sum: row.sum,
      max: row.max,
      histogram: normalizeHistogram(row.histogram),
    }));
  }

  /** Window aggregation in SQL (pulse, timeseries): a few GROUP BYs instead of a scan in Node. */
  async aggregate(request: EntryAggregation): Promise<EntryAggregateResult> {
    const pool = this.rawPool();
    if (this.postgresVersion === null) {
      try {
        const result = await pool.query<{ server_version_num: string }>('show server_version_num');
        this.postgresVersion = Number(result.rows[0]?.server_version_num ?? 0);
      } catch {
        this.postgresVersion = 0;
      }
    }
    return aggregateSql(
      {
        dateBin: this.postgresVersion >= 140_000,
        table: qualified(TELESCOPE_TABLES.entries, this.schema),
        execute: async (statement, params) =>
          (await pool.query(numbered(statement), params)).rows as Record<string, unknown>[],
      },
      request,
    );
  }
}

/** One delta per (metric, bucketStart), sorted by that key: an upsert may touch a row once. */
function mergeDeltasByBucket(deltas: RollupDelta[]): RollupDelta[] {
  const byKey = new Map<string, RollupDelta>();
  for (const delta of deltas) {
    const key = `${delta.metric}\u0000${delta.bucketStart}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { ...delta, histogram: normalizeHistogram(delta.histogram) });
    } else {
      existing.count += delta.count;
      existing.sum += delta.sum;
      existing.max = Math.max(existing.max, delta.max);
      existing.histogram = mergeHistograms(existing.histogram, delta.histogram);
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0) || a.bucketStart - b.bucketStart,
  );
}

/**
 * `INSERT ... ON CONFLICT DO UPDATE` for `rows` rollup buckets. The histogram is a fixed-length
 * JSON array rebuilt cell by cell as the stored cell (0 when the column is null or short) plus the
 * new one.
 */
function rollupUpsertSql(table: string, rows: number): string {
  const columns = ['metric', 'bucket_start', 'count', 'sum', 'max', 'histogram'];
  const values = Array.from(
    { length: rows },
    (_, row) =>
      `(${columns.map((column, index) => `$${row * columns.length + index + 1}${column === 'histogram' ? '::jsonb' : ''}`).join(', ')})`,
  );
  const cell = (source: string, index: number): string =>
    `coalesce((${source} ->> ${index})::bigint, 0)`;
  const merged = Array.from(
    { length: HISTOGRAM_BUCKET_COUNT },
    (_, index) => `${cell(`${table}."histogram"`, index)} + ${cell('excluded."histogram"', index)}`,
  ).join(', ');
  return `insert into ${table} (${columns.map((column) => `"${column}"`).join(', ')}) values ${values.join(', ')}
    on conflict ("metric", "bucket_start") do update set
      "count" = ${table}."count" + excluded."count",
      "sum" = ${table}."sum" + excluded."sum",
      "max" = greatest(${table}."max", excluded."max"),
      "histogram" = jsonb_build_array(${merged})`;
}
