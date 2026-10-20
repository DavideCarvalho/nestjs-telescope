import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entry } from '@dudousxd/nestjs-telescope';
import { isBatchOrigin, safeJsonParse } from '@dudousxd/nestjs-telescope';
import type { ColdEngine } from './engine.js';
import { type ColdFilter, matches } from './filter.js';
import type { ColdLocation, StoredObject } from './location.js';
import { newestFirst } from './rows.js';

export interface DuckDbEngineOptions {
  /** DuckDB `memory_limit`, e.g. `'512MB'`. */
  memoryLimit?: string;
  threads?: number;
  /**
   * Upper bound, in MB, on the local copies of S3 objects kept for DuckDB to read. Unused for a
   * directory location, which DuckDB reads in place. Defaults to 512.
   */
  localCacheMb?: number;
}

type DuckDbModule = typeof import('@duckdb/node-api');
type DuckDbConnection = Awaited<
  ReturnType<Awaited<ReturnType<DuckDbModule['DuckDBInstance']['create']>>['connect']>
>;
type DuckDbInstance = Awaited<ReturnType<DuckDbModule['DuckDBInstance']['create']>>;

/**
 * Opt-in engine on `@duckdb/node-api`. It never loads `httpfs`/`aws` — on first use DuckDB would
 * download them from extensions.duckdb.org, a native binary fetched after the image was scanned.
 * Instead, S3 objects are fetched whole through the host's own S3 client and DuckDB reads local
 * copies; a directory location is read in place. Extension autoload/autoinstall are disabled and
 * the configuration is locked, so a query cannot turn them back on.
 */
export class DuckDbEngine implements ColdEngine {
  readonly name = 'duckdb';
  private sdk: DuckDbModule | null = null;
  private instance: DuckDbInstance | null = null;
  private connection: DuckDbConnection | null = null;
  /** Created once, on first need; a promise so concurrent first reads share one directory. */
  private cacheDir: Promise<string> | null = null;
  /** Local copies of S3 objects, oldest first; objects are immutable per key. */
  private readonly copies = new Map<string, { path: string; size: number }>();
  private copiedBytes = 0;
  private readonly cacheBytes: number;

  constructor(
    private readonly location: ColdLocation,
    private readonly options: DuckDbEngineOptions = {},
  ) {
    this.cacheBytes = (options.localCacheMb ?? 512) * 1024 * 1024;
  }

  async init(): Promise<void> {
    try {
      this.sdk = await import('@duckdb/node-api');
    } catch (error) {
      throw new Error(
        `@dudousxd/nestjs-telescope-parquet: engine "duckdb" is configured but @duckdb/node-api is not installed. Install it, or remove \`engine: { duckdb }\` to use the default hyparquet engine. (${String(error)})`,
      );
    }
    this.instance = await this.sdk.DuckDBInstance.create(':memory:', {
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
      allow_community_extensions: 'false',
      ...(this.options.memoryLimit !== undefined ? { memory_limit: this.options.memoryLimit } : {}),
      ...(this.options.threads !== undefined ? { threads: String(this.options.threads) } : {}),
    });
    this.connection = await this.instance.connect();
    await this.connection.run('SET lock_configuration = true');
  }

  async close(): Promise<void> {
    this.connection?.closeSync();
    this.instance?.closeSync();
    this.connection = null;
    this.instance = null;
    if (this.cacheDir !== null) {
      await rm(await this.cacheDir, { recursive: true, force: true });
    }
    this.cacheDir = null;
  }

  async read(files: StoredObject[], filter: ColdFilter, limit?: number): Promise<Entry[]> {
    if (files.length === 0) return [];
    const { sdk, connection } = this.ready();
    const paths = await Promise.all(files.map((file) => this.pathFor(file)));
    const where: string[] = [];
    const values: Record<string, unknown> = {};
    const types: Record<string, unknown> = {};
    const bind = (name: string, value: unknown, type: unknown): string => {
      values[name] = value;
      types[name] = type;
      return `$${name}`;
    };
    if (filter.type !== undefined) where.push(`type = ${bind('type', filter.type, sdk.VARCHAR)}`);
    if (filter.batchId !== undefined) {
      where.push(`batch_id = ${bind('batch', filter.batchId, sdk.VARCHAR)}`);
    }
    if (filter.traceId !== undefined) {
      where.push(`trace_id = ${bind('trace', filter.traceId, sdk.VARCHAR)}`);
    }
    if (filter.familyHash !== undefined) {
      where.push(`family_hash = ${bind('family', filter.familyHash, sdk.VARCHAR)}`);
    }
    if (filter.tag !== undefined) {
      where.push(`list_contains(tags, ${bind('tag', filter.tag, sdk.VARCHAR)})`);
    }
    if (filter.ids !== undefined) {
      where.push(
        `list_contains(${bind('ids', sdk.listValue([...filter.ids]), sdk.LIST(sdk.VARCHAR))}, id)`,
      );
    }
    if (filter.beforeMs !== undefined) {
      where.push(`epoch_ms(created_at) < ${bind('before', BigInt(filter.beforeMs), sdk.BIGINT)}`);
    }
    if (filter.afterMs !== undefined) {
      where.push(`epoch_ms(created_at) > ${bind('after', BigInt(filter.afterMs), sdk.BIGINT)}`);
    }
    if (filter.cursor !== undefined) {
      const at = bind('cursorAt', BigInt(filter.cursor.createdAt), sdk.BIGINT);
      const id = bind('cursorId', filter.cursor.id, sdk.VARCHAR);
      where.push(`(epoch_ms(created_at) < ${at} OR (epoch_ms(created_at) = ${at} AND id < ${id}))`);
    }
    if (filter.search !== undefined) {
      where.push(`contains(lower(content), ${bind('search', filter.search, sdk.VARCHAR)})`);
    }
    const withContent = !filter.omitContent || filter.search !== undefined;
    const sql = `SELECT id, batch_id, type, family_hash, tags, sequence, duration_ms, origin,
        instance_id, trace_id, span_id, epoch_ms(created_at) AS created_at_ms
        ${withContent ? ', content' : ''}
      FROM read_parquet([${paths.map(sqlString).join(', ')}])
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      ${limit !== undefined ? `LIMIT ${Math.max(0, Math.trunc(limit))}` : ''}`;
    const reader = await connection
      .runAndReadAll(sql, values as never, types as never)
      .finally(() => this.evict());
    const entries: Entry[] = [];
    for (const row of reader.getRowObjectsJS() as Record<string, unknown>[]) {
      const content = typeof row.content === 'string' ? row.content : undefined;
      const entry: Entry = {
        id: String(row.id),
        batchId: String(row.batch_id),
        type: String(row.type),
        familyHash: (row.family_hash as string | null) ?? null,
        content: content === undefined || filter.omitContent ? null : safeJsonParse(content, null),
        tags: (row.tags as string[] | null) ?? [],
        sequence: Number(row.sequence),
        durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
        origin: isBatchOrigin(row.origin) ? row.origin : 'manual',
        instanceId: String(row.instance_id),
        traceId: (row.trace_id as string | null) ?? null,
        spanId: (row.span_id as string | null) ?? null,
        createdAt: new Date(Number(row.created_at_ms)),
      };
      // The same predicate the hyparquet engine applies, so the engines agree on edge cases.
      if (matches(entry, filter, content)) entries.push(entry);
    }
    return entries.sort(newestFirst);
  }

  async countTags(
    files: StoredObject[],
    prefix?: string,
    search?: string,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (files.length === 0) return counts;
    const { sdk, connection } = this.ready();
    const paths = await Promise.all(files.map((file) => this.pathFor(file)));
    const where: string[] = [];
    const values: Record<string, unknown> = {};
    const types: Record<string, unknown> = {};
    if (prefix !== undefined) {
      where.push('starts_with(tag, $prefix)');
      values.prefix = prefix;
      types.prefix = sdk.VARCHAR;
    }
    if (search) {
      where.push('contains(lower(tag), $search)');
      values.search = search.toLowerCase();
      types.search = sdk.VARCHAR;
    }
    const reader = await connection
      .runAndReadAll(
        `SELECT tag, count(*) AS n FROM (
         SELECT unnest(tags) AS tag FROM read_parquet([${paths.map(sqlString).join(', ')}])
       ) ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY tag`,
        values as never,
        types as never,
      )
      .finally(() => this.evict());
    for (const row of reader.getRowObjectsJS() as { tag: string; n: bigint | number }[]) {
      counts.set(row.tag, Number(row.n));
    }
    return counts;
  }

  private ready(): { sdk: DuckDbModule; connection: DuckDbConnection } {
    if (this.sdk === null || this.connection === null) {
      throw new Error('DuckDB engine used before init()');
    }
    return { sdk: this.sdk, connection: this.connection };
  }

  /** A local path DuckDB can open: the file itself for a directory, else a cached copy. */
  private async pathFor(file: StoredObject): Promise<string> {
    const local = this.location.localPath?.(file.key);
    if (local !== undefined) return local;
    const cached = this.copies.get(file.key);
    if (cached !== undefined) return cached.path;
    this.cacheDir ??= mkdtemp(join(tmpdir(), 'telescope-parquet-'));
    const dir = await this.cacheDir;
    const bytes = await this.location.read(file.key, 0, file.size);
    const path = join(dir, `${createHash('sha1').update(file.key).digest('hex')}.parquet`);
    await writeFile(path, new Uint8Array(bytes));
    this.copies.set(file.key, { path, size: bytes.byteLength });
    this.copiedBytes += bytes.byteLength;
    return path;
  }

  /** Runs after a query, never during one, so no copy a running query reads is removed. */
  private async evict(): Promise<void> {
    for (const [key, copy] of this.copies) {
      if (this.copiedBytes <= this.cacheBytes) return;
      this.copies.delete(key);
      this.copiedBytes -= copy.size;
      await rm(copy.path, { force: true });
    }
  }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
