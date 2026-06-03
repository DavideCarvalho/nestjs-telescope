// packages/mikro-orm/src/mikro-orm-storage.provider.ts
//
// A StorageProvider that persists Telescope entries to MySQL/SQLite via MikroORM.
//
// Connection ownership:
//
//  - This provider OWNS a dedicated MikroORM instance scoped to ONLY the
//    `TelescopeEntry` entity, running on its OWN connection. The connection
//    config is, by default, DERIVED from a host `MikroORM` the caller passes
//    (we copy only the connection-relevant keys), or it can be supplied
//    explicitly as MikroORM options. Either way the provider forces
//    `entities: [TelescopeEntry]`.
//
//  - Why a dedicated, single-entity ORM rather than reusing the host's:
//      (a) Schema self-heal: `schema.update()` has no per-entity filter, so it
//          diffs the WHOLE metadata against the WHOLE database. Running it on an
//          ORM whose metadata is only `TelescopeEntry` guarantees the diff can
//          never create, alter, or drop any of the host's other tables.
//      (b) No self-capture loop: the host ORM has Telescope's query logger wired
//          in. If storage I/O ran on it, every `INSERT INTO telescope_entries`
//          during a flush would be captured as a `query` entry, recorded,
//          flushed, and re-captured — a feedback loop. A separate connection the
//          host's loggerFactory never wraps eliminates this entirely.
//
//  - Boot lifecycle: `init()` (called once before first use) creates the owned
//    ORM and, when `ensureSchema` is on, ensures the database exists and runs an
//    ADDITIVE-only schema update (`{ safe: true }` — no DROP of tables or
//    columns). `close()` (called once at shutdown after the final flush) closes
//    the owned ORM.
//
// I/O design notes (unchanged):
//
//  - Per-op `em.fork()`: storage runs OUTSIDE the request scope (entries are
//    flushed from a background buffer, pruned by a scheduler, etc.), so every
//    method forks a fresh EntityManager. A fork has an empty identity map, which
//    avoids leaking stale managed entities across unrelated operations and is
//    safe for concurrent use across pods/requests.
//
//  - Keyset pagination: `get` returns entries newest-first (createdAt DESC, id
//    DESC tiebreak). A cursor encodes a (createdAt, id) POSITION — not an id
//    lookup — so "strictly older than the cursor" is expressed as the $or
//    `[{ createdAt < d }, { createdAt = d, id < cursorId }]`. Because it is a
//    position, pagination resumes correctly even if the cursor's original entry
//    was pruned. We fetch limit+1 rows to decide whether a next page exists.
//
//  - tagsText LIKE tag filtering: JSON-array querying is not portable across
//    MySQL and SQLite, so tag filters run against the space-padded `tagsText`
//    column via `LIKE '% <tag> %'`. The leading/trailing spaces make the first
//    and last tag matchable and prevent substring false-positives ('slow' must
//    not match 'slowest'). The `tags` JSON column stays the source of truth.
//
import type {
  Entry,
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
} from '@dudousxd/nestjs-telescope';
import { decodeCursor, encodeCursor, isBatchOrigin } from '@dudousxd/nestjs-telescope';
import type { EntityManager, FilterQuery, Options } from '@mikro-orm/core';
import { MikroORM, raw } from '@mikro-orm/core';
import { TelescopeEntry, type TelescopeEntryRow } from './telescope-entry.entity.js';

const DEFAULT_LIMIT = 50;

/**
 * Every persisted column EXCEPT `content`, used as the MikroORM `fields`
 * projection for content-less aggregate scans (omitContent). Selecting these
 * keeps the heavy `content` JSON blob out of the result set entirely — the main
 * perf win on MySQL where pulse/timeseries otherwise read every content blob.
 */
const CONTENTLESS_FIELDS = [
  'id',
  'batchId',
  'type',
  'familyHash',
  'tags',
  'tagsText',
  'sequence',
  'durationMs',
  'origin',
  'instanceId',
  'traceId',
  'spanId',
  'createdAt',
] as const;

/**
 * The owned ORM runs under a dedicated MikroORM `contextName` so it is isolated
 * from the HOST app's `RequestContext`. Without this, a host that wraps requests
 * in its own MikroORM context (e.g. `@mikro-orm/nestjs`'s `MikroOrmMiddleware`,
 * which runs on every route) would make our `em.find()` resolve against the
 * HOST's EntityManager — the host ORM doesn't know `TelescopeEntry`, so MikroORM
 * crashes looking up its (missing) metadata. A unique context name means our em
 * never collides with the host's entry in the shared `RequestContext` map.
 */
const TELESCOPE_CONTEXT_NAME = 'nestjs-telescope';

/**
 * Options for the dedicated, single-entity ORM the provider owns. These are
 * standard MikroORM `Options` (connection config) plus an optional
 * `ensureSchema` flag. Any `entities` provided here is overridden — the provider
 * always forces `entities: [TelescopeEntry]`.
 */
export type MikroOrmStorageProviderOptions = Options & { ensureSchema?: boolean };

function padTags(tags: string[]): string {
  return tags.length ? ` ${tags.join(' ')} ` : ' ';
}

/** A row that may have had `content` projected away (omitContent scans). */
type RowMaybeContentless = Omit<TelescopeEntryRow, 'content'> & { content?: unknown };

function rowToEntry(row: RowMaybeContentless, omitContent = false): Entry {
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

function entryToRowData(entry: Entry): TelescopeEntryRow {
  return { ...entry, tagsText: padTags(entry.tags) };
}

function resolveLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
}

/**
 * Connection-relevant keys copied from a host MikroORM's resolved config when
 * deriving the owned ORM's connection. Deliberately EXCLUDES entities,
 * migrations, seeder, subscribers, extensions, and discovery so the owned ORM
 * sees only `TelescopeEntry` and never inherits the host's metadata or wiring.
 */
function pickHostConnection(hostConfig: Options): Partial<Options> {
  const connection: Partial<Options> = {};
  if (hostConfig.driver !== undefined) connection.driver = hostConfig.driver;
  if (hostConfig.dbName !== undefined) connection.dbName = hostConfig.dbName;
  if (hostConfig.clientUrl !== undefined) connection.clientUrl = hostConfig.clientUrl;
  if (hostConfig.host !== undefined) connection.host = hostConfig.host;
  if (hostConfig.port !== undefined) connection.port = hostConfig.port;
  if (hostConfig.user !== undefined) connection.user = hostConfig.user;
  if (hostConfig.password !== undefined) connection.password = hostConfig.password;
  if (hostConfig.schema !== undefined) connection.schema = hostConfig.schema;
  if (hostConfig.driverOptions !== undefined) connection.driverOptions = hostConfig.driverOptions;
  if (hostConfig.pool !== undefined) connection.pool = hostConfig.pool;
  if (hostConfig.charset !== undefined) connection.charset = hostConfig.charset;
  if (hostConfig.collate !== undefined) connection.collate = hostConfig.collate;
  if (hostConfig.forceUtcTimezone !== undefined) {
    connection.forceUtcTimezone = hostConfig.forceUtcTimezone;
  }
  if (hostConfig.timezone !== undefined) connection.timezone = hostConfig.timezone;
  return connection;
}

export class MikroOrmStorageProvider implements StorageProvider {
  private readonly source: MikroORM | MikroOrmStorageProviderOptions;
  private readonly ensureSchema: boolean;
  private orm: MikroORM | null = null;

  constructor(
    source: MikroORM | MikroOrmStorageProviderOptions,
    opts?: { ensureSchema?: boolean },
  ) {
    this.source = source;
    if (opts?.ensureSchema !== undefined) {
      this.ensureSchema = opts.ensureSchema;
    } else if (!(source instanceof MikroORM) && source.ensureSchema !== undefined) {
      this.ensureSchema = source.ensureSchema;
    } else {
      this.ensureSchema = true;
    }
  }

  private buildOrmOptions(): Partial<Options> {
    if (this.source instanceof MikroORM) {
      const connection = pickHostConnection(this.source.config.getAll());
      return {
        ...connection,
        entities: [TelescopeEntry],
        contextName: TELESCOPE_CONTEXT_NAME,
        allowGlobalContext: true,
      };
    }

    const { ensureSchema: _ensureSchema, entities: _entities, ...rest } = this.source;
    return {
      ...rest,
      entities: [TelescopeEntry],
      contextName: TELESCOPE_CONTEXT_NAME,
      allowGlobalContext: true,
    };
  }

  async init(): Promise<void> {
    if (this.orm) return;
    this.orm = await MikroORM.init(this.buildOrmOptions());
    if (this.ensureSchema) {
      await this.orm.schema.ensureDatabase();
      // `{ safe: true }` disables BOTH table and column dropping, so the update
      // is additive-only: it creates the table and adds missing columns/indexes
      // but never drops anything that already exists.
      await this.orm.schema.update({ safe: true });
    }
  }

  async close(): Promise<void> {
    if (this.orm) {
      await this.orm.close(true);
      this.orm = null;
    }
  }

  private forkEm(): EntityManager {
    if (!this.orm) {
      throw new Error('MikroOrmStorageProvider: init() must run before use');
    }
    return this.orm.em.fork();
  }

  async store(entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const em = this.forkEm();
    for (const entry of entries) {
      em.create(TelescopeEntry, entryToRowData(entry));
    }
    await em.flush();
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const em = this.forkEm();
    const row = await em.findOne(TelescopeEntry, { id });
    if (!row) return;

    const { id: _ignoredId, ...rest } = patch;
    const patchData: Partial<TelescopeEntryRow> = { ...rest };
    if (patch.tags !== undefined) {
      patchData.tagsText = padTags(patch.tags);
    }
    em.assign(row, patchData);
    await em.flush();
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const em = this.forkEm();
    const row = await em.findOne(TelescopeEntry, { id });
    if (!row) return null;
    const batch = await this.batch(row.batchId);
    return { ...rowToEntry(row), batch };
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    const em = this.forkEm();
    const where: FilterQuery<TelescopeEntryRow> = {};

    if (query.type) where.type = query.type;
    if (query.familyHash) where.familyHash = query.familyHash;
    if (query.batchId) where.batchId = query.batchId;
    if (query.traceId !== undefined) where.traceId = query.traceId;
    if (query.tag) where.tagsText = { $like: `% ${query.tag} %` };

    if (query.before || query.after) {
      where.createdAt = {
        ...(query.after && { $gt: query.after }),
        ...(query.before && { $lt: query.before }),
      };
    }

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      where.$or = [
        { createdAt: { $lt: cursorDate } },
        { createdAt: cursorDate, id: { $lt: cursor.id } },
      ];
    }

    // Free-text scan over the stored content JSON, ANDed with every other filter
    // (and the cursor keyset). `content` is a JSON property, so a plain
    // `{ content: { $like } }` would JSON-encode the operand to `'"%term%"'` and
    // never match; `raw('content')` references the underlying text column directly,
    // yielding `content LIKE '%term%'`. The LIKE runs in SQL over the column, so it
    // is independent of the omitContent field projection. Wrapped in `$and` so it
    // composes with the cursor's own `$or` clause without clobbering it.
    const finalWhere: FilterQuery<TelescopeEntryRow> =
      query.search !== undefined
        ? { $and: [where, { [raw('content')]: { $like: `%${query.search}%` } }] }
        : where;

    const limit = resolveLimit(query.limit);
    const rows = await em.find(TelescopeEntry, finalWhere, {
      orderBy: { createdAt: 'desc', id: 'desc' },
      limit: limit + 1,
      // omitContent: project every column except the heavy content blob so the
      // driver never SELECTs/materializes it.
      ...(query.omitContent ? { fields: [...CONTENTLESS_FIELDS] } : {}),
    });

    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const last = slice.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt.getTime(), last.id) : null;

    return { data: slice.map((row) => rowToEntry(row, query.omitContent === true)), nextCursor };
  }

  async batch(batchId: string): Promise<Entry[]> {
    const em = this.forkEm();
    const rows = await em.find(TelescopeEntry, { batchId }, { orderBy: { sequence: 'asc' } });
    return rows.map((row) => rowToEntry(row));
  }

  async tags(prefix?: string): Promise<TagCount[]> {
    const em = this.forkEm();
    const rows = await em.find(
      TelescopeEntry,
      {},
      { orderBy: { createdAt: 'desc', id: 'desc' }, limit: 10000, fields: ['tags'] },
    );

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags) {
        if (prefix && !tag.startsWith(prefix)) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count }));
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    const em = this.forkEm();
    if (keepLast === undefined) {
      return em.nativeDelete(TelescopeEntry, { createdAt: { $lt: olderThan } });
    }

    const older = await em.find(
      TelescopeEntry,
      { createdAt: { $lt: olderThan } },
      { orderBy: { createdAt: 'desc', id: 'desc' }, fields: ['id'] },
    );
    const toDelete = older.slice(keepLast).map((row) => row.id);
    if (toDelete.length === 0) return 0;
    return em.nativeDelete(TelescopeEntry, { id: { $in: toDelete } });
  }

  async clear(): Promise<void> {
    const em = this.forkEm();
    await em.nativeDelete(TelescopeEntry, {});
  }
}
