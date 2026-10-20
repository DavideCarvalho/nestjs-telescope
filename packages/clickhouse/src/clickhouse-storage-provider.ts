import { randomUUID } from 'node:crypto';
import {
  type ClickHouseClient,
  type ClickHouseClientConfigOptions,
  type ClickHouseSettings,
  createClient,
} from '@clickhouse/client';
import {
  type BoundedPruneCapable,
  type BoundedPruneResult,
  type Entry,
  type EntryQuery,
  type EntryWithBatch,
  HISTOGRAM_BUCKET_COUNT,
  type Page,
  type RollupBucket,
  type RollupDelta,
  type RollupStore,
  type TagCount,
  type TagQuery,
  decodeCursor,
  encodeCursor,
  isBatchOrigin,
  normalizeHistogram,
  safeJsonParse,
} from '@dudousxd/nestjs-telescope';
import { Logger } from '@nestjs/common';
import {
  type ClickHouseRetention,
  DEFAULT_RETENTION,
  HISTOGRAM_COLUMNS,
  assertIdentifier,
  createEntriesTable,
  createRollupsTable,
  entriesTtl,
  modifyTtl,
  rollupsTtl,
  ttlFingerprint,
} from './schema.js';

export interface ClickHouseStorageOptions {
  /** A client the host owns. When given, `close()` leaves it open. */
  client?: ClickHouseClient;
  /** HTTP(S) endpoint, e.g. `http://localhost:8123`. Ignored when `client` is given. */
  url?: string;
  username?: string;
  password?: string;
  database?: string;
  /** Passed through to `createClient` (TLS, compression, keep-alive…). Ignored with `client`. */
  clientOptions?: ClickHouseClientConfigOptions;
  /** Defaults to `telescope_entries`. */
  table?: string;
  /** Defaults to `telescope_rollups`. */
  rollupTable?: string;
  /**
   * The `KeeperMap` table behind `markFamilySeen`. Defaults to `telescope_seen_families`. Needs
   * ClickHouse Keeper (or ZooKeeper) and `keeper_map_path_prefix` in the server config; without
   * them the provider has no `markFamilySeen` and the new-exception alert dedups per pod.
   */
  seenFamiliesTable?: string;
  /** Entry lifetimes, enforced as the table TTL. Defaults to 24 hours for every type. */
  retention?: ClickHouseRetention;
  /**
   * Server-side batching of inserts (`async_insert`, waiting for the flush). Many pods' small
   * Recorder flushes become few parts, and a resolved `store()` still means the rows are durable
   * and visible. Defaults to true.
   */
  asyncInsert?: boolean;
}

const DEFAULT_LIMIT = 50;
/** Attempts before a contended `markFamilySeen` gives up and reports "not new". */
const SEEN_ATTEMPTS = 20;
/** Logged once per process, not once per provider or boot. */
let warnedNoKeeper = false;
const BATCH_CAP = 1000;

const COLUMNS =
  'id, batch_id, type, family_hash, tags, sequence, duration_ms, origin, instance_id, trace_id, span_id, toUnixTimestamp64Milli(created_at) AS created_at_ms, version';

interface Row {
  id: string;
  batch_id: string;
  type: string;
  family_hash: string | null;
  content?: string;
  tags: string[];
  sequence: number | string;
  duration_ms: number | null;
  origin: string;
  instance_id: string;
  trace_id: string | null;
  span_id: string | null;
  created_at_ms: number | string;
  version: number | string;
}

/**
 * Telescope storage on ClickHouse: one `ReplacingMergeTree` table ordered by
 * `(type, created_at, id)` and partitioned by day, with retention as the table's TTL.
 *
 * - Nothing deletes rows. ClickHouse drops expired data during merges, so the `prune*` methods
 *   are no-ops that report zero and the host configures no `prune`. Without a pruner there is
 *   nothing to lock, so the lease pair is not implemented.
 * - `update()` writes the row again with a higher `version`; every read uses `FINAL`, so the
 *   newest version is the only one a caller sees, before and after the background merge.
 * - Rollups live in a `SummingMergeTree`, summed again at read time because merges are eventual.
 */
export class ClickHouseStorageProvider implements BoundedPruneCapable, RollupStore {
  private readonly client: ClickHouseClient;
  private readonly ownsClient: boolean;
  private readonly table: string;
  private readonly rollupTable: string;
  private readonly retention: ClickHouseRetention;
  private readonly insertSettings: ClickHouseSettings;
  private versionCounter = 0;
  private readonly seenTable: string;
  private seenAvailable = false;
  private readonly logger = new Logger('TelescopeClickHouseStorage');

  /**
   * Present only when `init()` could create the KeeperMap table, so a server without Keeper
   * behaves like any store without shared dedup instead of pretending to have it.
   */
  markFamilySeen?: (familyHash: string, nowMs: number, windowMs: number) => Promise<boolean>;

  constructor(options: ClickHouseStorageOptions = {}) {
    this.table = assertIdentifier(options.table ?? 'telescope_entries');
    this.rollupTable = assertIdentifier(options.rollupTable ?? 'telescope_rollups');
    this.seenTable = assertIdentifier(options.seenFamiliesTable ?? 'telescope_seen_families');
    this.retention = options.retention ?? DEFAULT_RETENTION;
    // Parsed now, so an invalid duration fails at construction rather than at boot.
    entriesTtl(this.retention);
    this.insertSettings =
      options.asyncInsert === false ? {} : { async_insert: 1, wait_for_async_insert: 1 };
    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
    } else {
      this.client = createClient({
        ...options.clientOptions,
        ...(options.url !== undefined ? { url: options.url } : {}),
        ...(options.username !== undefined ? { username: options.username } : {}),
        ...(options.password !== undefined ? { password: options.password } : {}),
        ...(options.database !== undefined ? { database: options.database } : {}),
      });
      this.ownsClient = true;
    }
  }

  async init(): Promise<void> {
    await this.ensureTable(this.table, entriesTtl(this.retention), createEntriesTable);
    await this.ensureTable(this.rollupTable, rollupsTtl(this.retention), createRollupsTable);
    await this.ensureSeenFamilies();
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.close();
  }

  async store(entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.client.insert({
      table: this.table,
      values: entries.map((entry) => this.toRow(entry, this.nextVersion(), 0)),
      format: 'JSONEachRow',
      clickhouse_settings: this.insertSettings,
    });
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const rows = await this.select<Row>(
      `SELECT ${COLUMNS}, content FROM ${this.table} FINAL WHERE id = {id:String} LIMIT 1`,
      { id },
    );
    const existing = rows[0];
    if (existing === undefined) return;
    const current = this.fromRow(existing);
    const merged: Entry = { ...current, ...patch, id: current.id };
    const version = Math.max(Number(existing.version) + 1, this.nextVersion());
    const values = [this.toRow(merged, version, 0)];
    // The sorting key is (type, created_at, id): a patch that moves either of the first two
    // writes a row with a different key, so the old one needs its own tombstone.
    const moved =
      merged.type !== current.type || merged.createdAt.getTime() !== current.createdAt.getTime();
    if (moved) values.push(this.toRow(current, version, 1));
    await this.client.insert({
      table: this.table,
      values,
      format: 'JSONEachRow',
      clickhouse_settings: this.insertSettings,
    });
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const rows = await this.select<Row>(
      `SELECT ${COLUMNS}, content FROM ${this.table} FINAL WHERE id = {id:String} LIMIT 1`,
      { id },
    );
    const row = rows[0];
    if (row === undefined) return null;
    const entry = this.fromRow(row);
    return { ...entry, batch: await this.batch(entry.batchId) };
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    if (query.ids !== undefined && query.ids.length === 0) return { data: [], nextCursor: null };
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.ids !== undefined) {
      where.push('id IN {ids:Array(String)}');
      params.ids = query.ids;
    }
    if (query.type !== undefined) {
      where.push('type = {type:String}');
      params.type = query.type;
    }
    if (query.familyHash !== undefined) {
      where.push('family_hash = {familyHash:String}');
      params.familyHash = query.familyHash;
    }
    if (query.batchId !== undefined) {
      where.push('batch_id = {batchId:String}');
      params.batchId = query.batchId;
    }
    if (query.traceId !== undefined) {
      where.push('trace_id = {traceId:String}');
      params.traceId = query.traceId;
    }
    if (query.tag !== undefined) {
      where.push('has(tags, {tag:String})');
      params.tag = query.tag;
    }
    if (query.search !== undefined) {
      where.push('positionCaseInsensitiveUTF8(content, {search:String}) > 0');
      params.search = query.search;
    }
    if (query.before !== undefined) {
      where.push("created_at < fromUnixTimestamp64Milli({before:Int64}, 'UTC')");
      params.before = query.before.getTime();
    }
    if (query.after !== undefined) {
      where.push("created_at > fromUnixTimestamp64Milli({after:Int64}, 'UTC')");
      params.after = query.after.getTime();
    }
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor) {
      where.push(
        "(created_at < fromUnixTimestamp64Milli({cursorAt:Int64}, 'UTC') OR (created_at = fromUnixTimestamp64Milli({cursorAt:Int64}, 'UTC') AND id < {cursorId:String}))",
      );
      params.cursorAt = cursor.createdAt;
      params.cursorId = cursor.id;
    }

    const limit =
      query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0
        ? query.limit
        : DEFAULT_LIMIT;
    params.limit = limit + 1;
    const columns = query.omitContent ? COLUMNS : `${COLUMNS}, content`;
    const rows = await this.select<Row>(
      `SELECT ${columns} FROM ${this.table} FINAL
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT {limit:UInt32}`,
      params,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => this.fromRow(row));
    const last = page.at(-1);
    return {
      data: page,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt.getTime(), last.id) : null,
    };
  }

  async batch(batchId: string): Promise<Entry[]> {
    const rows = await this.select<Row>(
      `SELECT ${COLUMNS}, content FROM ${this.table} FINAL
       WHERE batch_id = {batchId:String}
       ORDER BY sequence ASC, created_at ASC
       LIMIT ${BATCH_CAP}`,
      { batchId },
    );
    return rows.map((row) => this.fromRow(row));
  }

  async tags(prefix?: string, query?: TagQuery): Promise<TagCount[]> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (prefix !== undefined) {
      where.push('startsWith(tag, {prefix:String})');
      params.prefix = prefix;
    }
    const search = query?.search?.trim();
    if (search) {
      where.push('positionCaseInsensitiveUTF8(tag, {search:String}) > 0');
      params.search = search;
    }
    let page = '';
    if (query?.limit !== undefined) {
      page = 'LIMIT {limit:UInt32} OFFSET {offset:UInt32}';
      params.limit = query.limit;
      params.offset = query.offset ?? 0;
    }
    const rows = await this.select<{ tag: string; count: number | string }>(
      `SELECT tag, count() AS count FROM ${this.table} FINAL ARRAY JOIN tags AS tag
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY tag
       ORDER BY count DESC, tag ASC
       ${page}`,
      params,
    );
    return rows.map((row) => ({ tag: row.tag, count: Number(row.count) }));
  }

  /** Retention is the table TTL; there is nothing to delete. */
  async prune(): Promise<number> {
    return 0;
  }

  /** Retention is the table TTL; there is nothing to delete. */
  async pruneScoped(): Promise<number> {
    return 0;
  }

  /** Retention is the table TTL; there is nothing to delete. */
  async pruneScopedBatch(): Promise<BoundedPruneResult> {
    return { deleted: 0, hasMore: false };
  }

  async clear(): Promise<void> {
    await this.client.command({ query: `TRUNCATE TABLE IF EXISTS ${this.table}` });
    await this.client.command({ query: `TRUNCATE TABLE IF EXISTS ${this.rollupTable}` });
    if (this.seenAvailable) {
      await this.client.command({ query: `TRUNCATE TABLE IF EXISTS ${this.seenTable}` });
    }
  }

  async recordRollups(deltas: RollupDelta[]): Promise<void> {
    if (deltas.length === 0) return;
    await this.client.insert({
      table: this.rollupTable,
      values: deltas.map((delta) => {
        const histogram = normalizeHistogram(delta.histogram);
        const row: Record<string, unknown> = {
          metric: delta.metric,
          bucket_start: toDateTime64(delta.bucketStart),
          count: delta.count,
          sum: delta.sum,
          max: delta.max,
        };
        HISTOGRAM_COLUMNS.forEach((column, index) => {
          row[column] = histogram[index] ?? 0;
        });
        return row;
      }),
      format: 'JSONEachRow',
      clickhouse_settings: this.insertSettings,
    });
  }

  async queryRollups(
    metrics: string[],
    fromBucket: number,
    toBucket: number,
  ): Promise<RollupBucket[]> {
    if (metrics.length === 0) return [];
    const histogram = HISTOGRAM_COLUMNS.map((column) => `sum(${column}) AS ${column}`).join(', ');
    const rows = await this.select<Record<string, number | string>>(
      `SELECT metric, toUnixTimestamp64Milli(bucket_start) AS bucket_ms,
              sum(count) AS count, sum(sum) AS sum, max(max) AS max, ${histogram}
       FROM ${this.rollupTable}
       WHERE metric IN {metrics:Array(String)}
         AND bucket_start >= fromUnixTimestamp64Milli({from:Int64}, 'UTC')
         AND bucket_start <= fromUnixTimestamp64Milli({to:Int64}, 'UTC')
       GROUP BY metric, bucket_start`,
      { metrics, from: fromBucket, to: toBucket },
    );
    return rows.map((row) => ({
      metric: String(row.metric),
      bucketStart: Number(row.bucket_ms),
      count: Number(row.count),
      sum: Number(row.sum),
      max: Number(row.max),
      histogram: Array.from({ length: HISTOGRAM_BUCKET_COUNT }, (_, index) =>
        Number(row[`h${index}`] ?? 0),
      ),
    }));
  }

  private async ensureSeenFamilies(): Promise<void> {
    try {
      const [db] = await this.select<{ db: string }>('SELECT currentDatabase() AS db', {});
      const [database, name] = this.seenTable.includes('.')
        ? (this.seenTable.split('.') as [string, string])
        : [db?.db ?? 'default', this.seenTable];
      await this.client.command({
        query: `CREATE TABLE IF NOT EXISTS ${this.seenTable}
          (family_hash String, last_seen Int64, claim String)
          ENGINE = KeeperMap('/telescope/${database}/${name}')
          PRIMARY KEY family_hash`,
      });
      this.seenAvailable = true;
      this.markFamilySeen = (familyHash, nowMs, windowMs) =>
        this.markSeen(familyHash, nowMs, windowMs);
    } catch (error) {
      this.seenAvailable = false;
      // Removed rather than set to undefined: callers test for the property itself.
      Reflect.deleteProperty(this, 'markFamilySeen');
      if (warnedNoKeeper) return;
      warnedNoKeeper = true;
      this.logger.warn(
        `ClickHouse storage has no shared new-exception dedup: creating the KeeperMap table ${this.seenTable} failed (${error instanceof Error ? error.message : String(error)}). The new-exception alert will fire once per pod. To enable it, run ClickHouse Keeper or ZooKeeper and set <keeper_map_path_prefix> in the server config.`,
      );
    }
  }

  /**
   * The SPI's sliding window: `true` iff `familyHash` was never seen or last seen `windowMs` or
   * more ago, and the sighting is recorded either way. Atomic across pods through KeeperMap's
   * strict mode, where inserting an existing key fails and an update fails if the key changed
   * since it was read:
   *  - a new family is claimed by inserting it; only one concurrent insert succeeds;
   *  - an expired family is claimed by an update conditioned on the `last_seen` that was read,
   *    stamping this call's `claim` token, and the winner is whoever's token is read back.
   * Rows are never deleted here: a deleted and recreated Keeper node restarts at version 0, so a
   * stale conditional write could pass the version check and overwrite the winner.
   */
  private async markSeen(familyHash: string, nowMs: number, windowMs: number): Promise<boolean> {
    const strict = { keeper_map_strict_mode: 1 } as ClickHouseSettings;
    const claim = randomUUID();
    const read = async () =>
      (
        await this.select<{ last_seen: number | string; claim: string }>(
          `SELECT last_seen, claim FROM ${this.seenTable} WHERE family_hash = {hash:String}`,
          { hash: familyHash },
        )
      )[0];
    for (let attempt = 0; attempt < SEEN_ATTEMPTS; attempt += 1) {
      const row = await read();
      try {
        if (row === undefined) {
          await this.client.insert({
            table: this.seenTable,
            values: [{ family_hash: familyHash, last_seen: nowMs, claim }],
            format: 'JSONEachRow',
            clickhouse_settings: strict,
          });
          return true;
        }
        const last = Number(row.last_seen);
        const expired = nowMs - last >= windowMs;
        await this.client.command({
          query: expired
            ? `ALTER TABLE ${this.seenTable} UPDATE last_seen = {now:Int64}, claim = {claim:String}
               WHERE family_hash = {hash:String} AND last_seen = {last:Int64}`
            : `ALTER TABLE ${this.seenTable} UPDATE last_seen = greatest(last_seen, {now:Int64})
               WHERE family_hash = {hash:String}`,
          query_params: { hash: familyHash, now: nowMs, last, claim },
          clickhouse_settings: strict,
        });
        if (!expired) return false;
        return (await read())?.claim === claim;
      } catch (error) {
        if (!isKeeperConflict(error)) throw error;
      }
    }
    return false;
  }

  /**
   * Creates `table` when missing; otherwise re-applies its TTL when the configured retention no
   * longer matches the fingerprint in the table comment. Comparing fingerprints rather than
   * re-running `MODIFY TTL` every boot matters: the statement rewrites TTL metadata for every
   * part of what can be a very large table.
   */
  private async ensureTable(
    table: string,
    ttl: string,
    create: (table: string, ttl: string) => string,
  ): Promise<void> {
    await this.client.command({ query: create(table, ttl) });
    const [database, name] = table.includes('.')
      ? (table.split('.') as [string, string])
      : [null, table];
    const rows = await this.select<{ comment: string }>(
      `SELECT comment FROM system.tables
       WHERE database = ${database === null ? 'currentDatabase()' : '{database:String}'}
         AND name = {name:String}`,
      { name, ...(database === null ? {} : { database }) },
    );
    if (rows[0]?.comment === ttlFingerprint(ttl)) return;
    for (const statement of modifyTtl(table, ttl)) {
      await this.client.command({ query: statement });
    }
  }

  private async select<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
    const result = await this.client.query({ query, query_params: params, format: 'JSONEachRow' });
    return result.json<T>();
  }

  /** Strictly increasing within the process, and above any version written before it. */
  private nextVersion(): number {
    this.versionCounter = (this.versionCounter + 1) % 1000;
    return Date.now() * 1000 + this.versionCounter;
  }

  private toRow(entry: Entry, version: number, isDeleted: 0 | 1): Record<string, unknown> {
    return {
      id: entry.id,
      batch_id: entry.batchId,
      type: entry.type,
      family_hash: entry.familyHash,
      content: JSON.stringify(entry.content ?? null),
      tags: entry.tags,
      sequence: entry.sequence,
      duration_ms: entry.durationMs,
      origin: entry.origin,
      instance_id: entry.instanceId,
      trace_id: entry.traceId,
      span_id: entry.spanId,
      created_at: toDateTime64(entry.createdAt.getTime()),
      version,
      is_deleted: isDeleted,
    };
  }

  private fromRow(row: Row): Entry {
    return {
      id: row.id,
      batchId: row.batch_id,
      type: row.type,
      familyHash: row.family_hash,
      content: row.content === undefined ? null : safeJsonParse<unknown>(row.content, null),
      tags: row.tags,
      sequence: Number(row.sequence),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      origin: isBatchOrigin(row.origin) ? row.origin : 'manual',
      instanceId: row.instance_id,
      traceId: row.trace_id,
      spanId: row.span_id,
      createdAt: new Date(Number(row.created_at_ms)),
    };
  }
}

/** `YYYY-MM-DD hh:mm:ss.sss` in UTC — unambiguous input for a `DateTime64(3, 'UTC')` column. */
function toDateTime64(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * A KeeperMap strict-mode conflict: another writer changed or created the key first. The client
 * wraps some server errors, so the cause chain is checked too.
 */
function isKeeperConflict(error: unknown): boolean {
  for (let current = error; current instanceof Object; ) {
    const { code, message, cause } = current as {
      code?: string;
      message?: string;
      cause?: unknown;
    };
    if (code === '999' || /KEEPER_EXCEPTION|Node exists|Bad version/i.test(message ?? '')) {
      return true;
    }
    current = cause;
  }
  return false;
}
