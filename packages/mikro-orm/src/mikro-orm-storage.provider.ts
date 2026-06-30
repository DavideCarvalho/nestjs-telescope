import { createHash } from 'node:crypto';
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
//    `entities: [TelescopeEntry, TelescopeRollup]`.
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
  PruneScope,
  RollupBucket,
  RollupDelta,
  RollupStore,
  StorageProvider,
  TagCount,
} from '@dudousxd/nestjs-telescope';
import {
  decodeCursor,
  encodeCursor,
  isBatchOrigin,
  mergeHistograms,
  normalizeHistogram,
} from '@dudousxd/nestjs-telescope';
import type { EntityManager, EntityMetadata, FilterQuery, Options } from '@mikro-orm/core';
import { MikroORM, raw } from '@mikro-orm/core';
import { TelescopeEntry, type TelescopeEntryRow } from './telescope-entry.entity.js';
import { TelescopeRollup, type TelescopeRollupRow } from './telescope-rollup.entity.js';
import { TelescopeSchemaMeta } from './telescope-schema-meta.entity.js';

const DEFAULT_LIMIT = 50;

/**
 * Hand-bump escape hatch for DDL changes that are NOT visible in entity metadata
 * (e.g. a collation tweak, an index expression, anything `schema.update` would
 * emit but the fingerprint inputs below can't see). Incrementing this forces
 * every pod to re-run the additive `schema.update` once, then re-cache.
 */
const SCHEMA_REVISION = 1;

/** Stable PK of the single fingerprint marker row. */
const SCHEMA_META_ID = 'mikro-orm';

/**
 * Cross-driver DDL for the fingerprint marker table. `if not exists` keeps it
 * idempotent and introspection-free (no `information_schema` round-trip), and
 * the unquoted lowercase identifiers + portable `varchar`/`bigint` types parse
 * on MySQL, PostgreSQL, and SQLite alike. Mirrors `TelescopeSchemaMeta`.
 */
const CREATE_SCHEMA_META_TABLE_SQL =
  'create table if not exists telescope_schema_meta (' +
  'id varchar(32) not null, ' +
  'fingerprint varchar(64) not null, ' +
  'applied_at bigint not null, ' +
  'primary key (id))';

/** A shared advisory-lock name/key both lock dialects derive from. */
const SCHEMA_LOCK_NAME = 'telescope_schema';

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
 * always forces `entities: [TelescopeEntry, TelescopeRollup]`.
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

// ── Schema fingerprint gate ──────────────────────────────────────────────────
//
// `schema.update({ safe: true })` introspects the WHOLE database's
// `information_schema` to diff it against telescope's two entities, emitting zero
// DDL in steady state — ~1.5–3s of round-trips on a remote DB on EVERY boot. The
// gate replaces that with: (1) ensure the `telescope_schema_meta` marker exists,
// (2) read its one fingerprint row, (3) compute the expected fingerprint purely
// in memory from entity metadata. When they match we SKIP `schema.update`
// entirely; only an absent/mismatched fingerprint (fresh DB, entity change, or
// SCHEMA_REVISION bump) pays for the introspection, then re-caches the marker.

/** One column's identity inside the fingerprint. Keys authored alphabetically so
 * `JSON.stringify` (insertion-order) emits a canonical, sorted-key string. */
interface ColumnFingerprint {
  autoincrement: boolean;
  default: string | number | boolean | null;
  name: string;
  nullable: boolean;
  primary: boolean;
  type: string;
}

/** One index's identity. `properties` is the sorted list of indexed columns. */
interface IndexFingerprint {
  name: string;
  properties: string[];
}

/** One table's identity: name plus its sorted columns and sorted indexes. */
interface TableFingerprint {
  columns: ColumnFingerprint[];
  indexes: IndexFingerprint[];
  tableName: string;
}

/** The full canonical payload hashed into the fingerprint. */
interface SchemaFingerprintPayload {
  collate: string | null;
  platform: string;
  revision: number;
  tables: TableFingerprint[];
}

/**
 * Table names the gate owns and fingerprints — `telescope_entries` and
 * `telescope_rollups`. Derived from metadata (never hardcoded) so a future
 * tableName rename flows through automatically. Deliberately EXCLUDES the marker
 * table, whose own shape must never invalidate the gate.
 */
function collectOwnedTableNames(orm: MikroORM): string[] {
  const metadata = orm.getMetadata();
  return [metadata.get(TelescopeEntry).tableName, metadata.get(TelescopeRollup).tableName];
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Maps an entity's properties to per-column fingerprints, expanding any
 * multi-column property by its `fieldNames`. Columns are sorted by name. */
function columnsOf(meta: EntityMetadata): ColumnFingerprint[] {
  const columns: ColumnFingerprint[] = [];
  for (const prop of meta.props) {
    prop.fieldNames.forEach((fieldName, index) => {
      columns.push({
        autoincrement: prop.autoincrement === true,
        default: prop.default ?? null,
        name: fieldName,
        nullable: prop.nullable === true,
        primary: prop.primary === true,
        type: prop.columnTypes[index] ?? prop.columnTypes[0] ?? prop.type,
      });
    });
  }
  return columns.sort((left, right) => compareStrings(left.name, right.name));
}

function indexNameFromFlag(flag: boolean | string | undefined): string {
  return typeof flag === 'string' ? flag : '';
}

/**
 * Index fingerprints from BOTH property-level flags (`{ index: true }` /
 * `{ unique: true }`, which is how the telescope entities declare every index)
 * AND any entity-level `meta.indexes`. Without the property-level pass, flipping
 * an existing column to indexed (no new column) would slip past the gate. Sorted
 * by name then properties for determinism.
 */
function indexesOf(meta: EntityMetadata): IndexFingerprint[] {
  const indexes: IndexFingerprint[] = [];
  for (const prop of meta.props) {
    if (prop.index) {
      indexes.push({
        name: indexNameFromFlag(prop.index),
        properties: [...prop.fieldNames].sort(),
      });
    }
    if (prop.unique) {
      indexes.push({
        name: indexNameFromFlag(prop.unique),
        properties: [...prop.fieldNames].sort(),
      });
    }
  }
  for (const index of meta.indexes) {
    const declared = index.properties;
    const properties = Array.isArray(declared)
      ? [...declared]
      : declared !== undefined
        ? [declared]
        : [];
    indexes.push({ name: index.name ?? '', properties: properties.map(String).sort() });
  }
  return indexes.sort(
    (left, right) =>
      compareStrings(left.name, right.name) ||
      compareStrings(left.properties.join(','), right.properties.join(',')),
  );
}

/**
 * Pure, in-memory sha256 of a CANONICAL serialization of the owned tables' shape
 * (sorted tables, sorted columns, sorted indexes; object keys authored
 * alphabetically so `JSON.stringify` is order-stable). The platform name is
 * folded in so a SQLite CI marker can never satisfy a MySQL boot, the configured
 * collation so a collation change re-heals, and SCHEMA_REVISION as the manual
 * escape hatch. Never reads enumeration order — everything is sorted.
 */
function computeExpectedFingerprint(orm: MikroORM, ownedTableNames: string[]): string {
  const owned = new Set(ownedTableNames);
  const tables: TableFingerprint[] = [];
  for (const meta of orm.getMetadata()) {
    if (!owned.has(meta.tableName)) continue;
    tables.push({ columns: columnsOf(meta), indexes: indexesOf(meta), tableName: meta.tableName });
  }
  tables.sort((left, right) => compareStrings(left.tableName, right.tableName));

  const collate = orm.config.get('collate');
  const payload: SchemaFingerprintPayload = {
    collate: collate ?? null,
    platform: orm.em.getPlatform().constructor.name,
    revision: SCHEMA_REVISION,
    tables,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Reads the single stored fingerprint, or null when the marker row is absent. */
async function readStoredFingerprint(orm: MikroORM): Promise<string | null> {
  const em = orm.em.fork();
  const row = await em.findOne(TelescopeSchemaMeta, { id: SCHEMA_META_ID });
  return row ? row.fingerprint : null;
}

/** Driver-agnostic upsert of the single marker row with the reconciled fingerprint. */
async function writeStoredFingerprint(orm: MikroORM, fingerprint: string): Promise<void> {
  const em = orm.em.fork();
  await em.upsert(TelescopeSchemaMeta, {
    id: SCHEMA_META_ID,
    fingerprint,
    appliedAt: Date.now(),
  });
}

/** Releasable handle for the best-effort schema advisory lock. */
interface SchemaLock {
  release: () => Promise<void>;
}

/**
 * Best-effort advisory lock so concurrent pods serialize the one-time heal
 * instead of all introspecting at once. MySQL/MariaDB use `GET_LOCK`,
 * PostgreSQL `pg_advisory_lock(hashtext(...))`; SQLite and unknown drivers get a
 * no-op (single-writer or unsupported). Acquisition failures (permissions,
 * timeout) degrade to a no-op so the heal still proceeds — the re-SELECT after
 * locking is what actually prevents duplicate work, the lock just reduces it.
 */
async function acquireSchemaLock(orm: MikroORM): Promise<SchemaLock> {
  const platform = orm.em.getPlatform().constructor.name.toLowerCase();
  const connection = orm.em.getConnection();
  const noop: SchemaLock = {
    release: async () => {
      /* nothing acquired */
    },
  };
  try {
    if (platform.includes('mysql') || platform.includes('maria')) {
      await connection.execute(`select get_lock('${SCHEMA_LOCK_NAME}', 10) as locked`);
      return {
        release: async () => {
          try {
            await connection.execute(`select release_lock('${SCHEMA_LOCK_NAME}')`);
          } catch {
            /* lock auto-releases on connection close */
          }
        },
      };
    }
    if (platform.includes('postgre')) {
      await connection.execute(`select pg_advisory_lock(hashtext('${SCHEMA_LOCK_NAME}'))`);
      return {
        release: async () => {
          try {
            await connection.execute(`select pg_advisory_unlock(hashtext('${SCHEMA_LOCK_NAME}'))`);
          } catch {
            /* lock auto-releases on connection close */
          }
        },
      };
    }
  } catch {
    /* advisory lock unavailable → proceed without it */
  }
  return noop;
}

export class MikroOrmStorageProvider implements StorageProvider, RollupStore {
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
        entities: [TelescopeEntry, TelescopeRollup, TelescopeSchemaMeta],
        contextName: TELESCOPE_CONTEXT_NAME,
        allowGlobalContext: true,
      };
    }

    const { ensureSchema: _ensureSchema, entities: _entities, ...rest } = this.source;
    return {
      ...rest,
      entities: [TelescopeEntry, TelescopeRollup, TelescopeSchemaMeta],
      contextName: TELESCOPE_CONTEXT_NAME,
      allowGlobalContext: true,
    };
  }

  async init(): Promise<void> {
    if (this.orm) return;
    this.orm = await MikroORM.init(this.buildOrmOptions());
    if (this.ensureSchema) {
      await this.reconcileSchema(this.orm);
    }
  }

  /**
   * Fingerprint-gated schema reconciliation. Replaces a bare
   * `ensureDatabase(); schema.update()` so steady-state boots skip the
   * whole-database introspection (see the gate notes above the helpers).
   *
   * FRESH-DB ORDERING: `ensureDatabase()` runs FIRST, before the marker table is
   * touched. The provider owns a DEDICATED connection, so on a brand-new DB the
   * database itself may not exist yet — a `create table telescope_schema_meta`
   * issued before `ensureDatabase()` would hit "unknown database" on MySQL/PG.
   * `ensureDatabase()` creates it when missing and is a single cheap existence
   * check when it already exists (the common case: the host app is already
   * connected to that database), so paying for it every boot is negligible next
   * to the multi-second `schema.update` introspection the gate eliminates.
   */
  private async reconcileSchema(orm: MikroORM): Promise<void> {
    // (0) Create the database if the owned connection points at one that does
    //     not exist yet. MUST precede any statement on the connection.
    await orm.schema.ensureDatabase();

    const ownedTableNames = collectOwnedTableNames(orm);

    // (1) Idempotent, introspection-free marker table (empty-DB safe).
    await orm.em.getConnection().execute(CREATE_SCHEMA_META_TABLE_SQL);

    // (2) One PK read + (3) in-memory expected fingerprint.
    const stored = await readStoredFingerprint(orm);
    const expected = computeExpectedFingerprint(orm, ownedTableNames);

    // (4) Steady state: identical fingerprint ⇒ skip the whole-DB schema.update.
    if (stored === expected) return;

    // (5) Absent/mismatch ⇒ heal once, under a best-effort advisory lock so
    //     concurrent pods don't all introspect.
    const lock = await acquireSchemaLock(orm);
    try {
      // Another pod may have healed between our SELECT and the lock; re-check.
      const reStored = await readStoredFingerprint(orm);
      if (reStored === expected) return;

      // `{ safe: true }` disables BOTH table and column dropping, so the update
      // is additive-only: it creates tables and adds missing columns/indexes but
      // never drops anything that already exists.
      await orm.schema.update({ safe: true });
      await writeStoredFingerprint(orm, expected);
    } finally {
      await lock.release();
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

    if (query.ids !== undefined) {
      // Empty id set ⇒ no rows (an `id IN ()` would match nothing anyway, but we
      // skip the round-trip entirely).
      if (query.ids.length === 0) {
        return { data: [], nextCursor: null };
      }
      where.id = { $in: query.ids };
    }
    // Presence-based, not truthy: an explicit empty-string filter must still
    // apply (matching the in-memory/sqlite/redis providers, which all use
    // `!== undefined`). A truthy check would silently drop a `type: ''` filter.
    if (query.type !== undefined) where.type = query.type;
    if (query.familyHash !== undefined) where.familyHash = query.familyHash;
    if (query.batchId !== undefined) where.batchId = query.batchId;
    if (query.traceId !== undefined) where.traceId = query.traceId;
    if (query.tag !== undefined) where.tagsText = { $like: `% ${query.tag} %` };

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

  async pruneScoped(input: PruneScope): Promise<number> {
    const em = this.forkEm();
    // `createdAt < before` plus the type selector (single type, or all-except a
    // set, or — when neither is given — no type filter). MikroORM renders the
    // type clause to `type = ?` / `type not in (?, …)` on every driver.
    const where: FilterQuery<TelescopeEntryRow> = { createdAt: { $lt: input.before } };
    if (input.type !== undefined) {
      where.type = input.type;
    } else if (input.excludeTypes !== undefined && input.excludeTypes.length > 0) {
      where.type = { $nin: input.excludeTypes };
    }
    if (input.keepLast === undefined) {
      return em.nativeDelete(TelescopeEntry, where);
    }

    const older = await em.find(TelescopeEntry, where, {
      orderBy: { createdAt: 'desc', id: 'desc' },
      fields: ['id'],
    });
    const toDelete = older.slice(input.keepLast).map((row) => row.id);
    if (toDelete.length === 0) return 0;
    return em.nativeDelete(TelescopeEntry, { id: { $in: toDelete } });
  }

  async clear(): Promise<void> {
    const em = this.forkEm();
    await em.nativeDelete(TelescopeEntry, {});
    await em.nativeDelete(TelescopeRollup, {});
  }

  // ── RollupStore SPI ────────────────────────────────────────────────────────

  /**
   * Additively merge deltas into `telescope_rollups`, matching the sqlite
   * provider's `on conflict do update set count = count + excluded.count, ...`
   * semantics: accumulate count/sum and keep a running max per
   * (metric, bucketStart).
   *
   * Implemented as a read-modify-write inside ONE transaction rather than a
   * native upsert. MikroORM's `em.upsert` / `qb.onConflict().merge()` REPLACE
   * conflicting columns; neither expresses a portable `count = count +
   * excluded.count` self-referential increment across MySQL and SQLite without
   * driver-specific raw SQL. The transactional read-modify-write is portable,
   * cast-free, and — because the whole batch commits atomically with row locks
   * on the touched PKs — safe to call repeatedly and concurrently: concurrent
   * writers serialize on the same (metric, bucketStart) rows, so no increment is
   * lost. New buckets are inserted; existing ones accumulate.
   */
  async recordRollups(deltas: RollupDelta[]): Promise<void> {
    if (deltas.length === 0) return;
    const em = this.forkEm();
    await em.transactional(async (tx) => {
      for (const delta of deltas) {
        const existing = await tx.findOne(TelescopeRollup, {
          metric: delta.metric,
          bucketStart: delta.bucketStart,
        });
        if (existing) {
          existing.count += delta.count;
          existing.sum += delta.sum;
          existing.max = Math.max(existing.max, delta.max);
          // Element-wise histogram merge; legacy null reads back as zeros.
          existing.histogram = mergeHistograms(
            normalizeHistogram(existing.histogram),
            delta.histogram,
          );
        } else {
          tx.create(TelescopeRollup, {
            metric: delta.metric,
            bucketStart: delta.bucketStart,
            count: delta.count,
            sum: delta.sum,
            max: delta.max,
            histogram: normalizeHistogram(delta.histogram),
          });
        }
      }
    });
  }

  async queryRollups(
    metrics: string[],
    fromBucket: number,
    toBucket: number,
  ): Promise<RollupBucket[]> {
    if (metrics.length === 0) return [];
    const em = this.forkEm();
    const rows = await em.find(TelescopeRollup, {
      metric: { $in: metrics },
      bucketStart: { $gte: fromBucket, $lte: toBucket },
    });
    return rows.map((row: TelescopeRollupRow) => ({
      metric: row.metric,
      bucketStart: row.bucketStart,
      count: row.count,
      sum: row.sum,
      max: row.max,
      histogram: normalizeHistogram(row.histogram),
    }));
  }
}
