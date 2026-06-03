// packages/mikro-orm/src/mikro-orm-storage.provider.integration.spec.ts
//
// Integration: real MikroORM with the SqliteDriver. The provider now OWNS its
// own dedicated, single-entity ORM, so every test constructs the provider with
// connection options (or a host ORM), calls `init()` before use, and `close()`
// in afterEach.
//
// For ordinary CRUD we use `:memory:`: the provider keeps one long-lived
// connection for its whole lifetime, so the in-memory DB persists across all
// forked operations within a single test.
//
// Two structural guards use a temp FILE db so a second connection can observe
// the schema the provider produced:
//   - "self-heals additively" proves `init()` ADDS a missing column without
//     dropping pre-existing data.
//   - "leaves host tables untouched" proves the dedicated single-entity ORM
//     never diffs (and therefore never alters) the host's other tables.
//
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entry } from '@dudousxd/nestjs-telescope';
import { EntitySchema, MikroORM, RequestContext } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MikroOrmStorageProvider } from './mikro-orm-storage.provider.js';
import { TelescopeEntry } from './telescope-entry.entity.js';

let idCounter = 0;

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: overrides.id ?? `entry-${idCounter++}-${Math.random().toString(36).slice(2, 8)}`,
    batchId: 'b1',
    type: 'request',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i1',
    traceId: null,
    spanId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('MikroOrmStorageProvider integration (sqlite)', () => {
  let provider: MikroOrmStorageProvider;

  beforeEach(() => {
    provider = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: ':memory:' });
  });

  afterEach(async () => {
    await provider.close();
  });

  it('init() self-heals: creates the table from scratch on a fresh db', async () => {
    // No manual schema setup — only init() runs. If store/get succeed, the
    // provider must have created `telescope_entries` itself.
    await provider.init();

    await provider.store([makeEntry({ id: 'fresh' })]);
    const page = await provider.get({});
    expect(page.data.map((e) => e.id)).toEqual(['fresh']);
  });

  it('works while a HOST RequestContext is active (no contextName collision)', async () => {
    // Regression: hosts like @mikro-orm/nestjs wrap EVERY route in their own
    // MikroORM RequestContext (MikroOrmMiddleware). Telescope's HTTP routes run
    // inside it. If the owned ORM shared the default contextName, our em.find()
    // would resolve to the HOST's EntityManager (which doesn't know
    // TelescopeEntry) and crash on missing metadata. The owned ORM uses a unique
    // contextName so it stays isolated. This test FAILS without that isolation.
    const HostThing = new EntitySchema<{ id: number }>({
      name: 'HostThing',
      tableName: 'host_thing',
      properties: { id: { type: 'integer', primary: true } },
    });
    const hostOrm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [HostThing],
      allowGlobalContext: true,
    });
    await hostOrm.schema.create();

    const scoped = new MikroOrmStorageProvider(hostOrm);
    await scoped.init();
    await scoped.store([makeEntry({ id: 'ctx-a' }), makeEntry({ id: 'ctx-b' })]);

    // Run reads INSIDE the host's RequestContext — this is what crashed in flip.
    await RequestContext.create(hostOrm.em, async () => {
      const page = await scoped.get({});
      expect(page.data.map((e) => e.id).sort()).toEqual(['ctx-a', 'ctx-b']);
      const found = await scoped.find('ctx-a');
      expect(found?.id).toBe('ctx-a');
      const batch = await scoped.batch('b1');
      expect(batch.length).toBe(2);
    });

    await scoped.close();
    await hostOrm.close(true);
  });

  it('store + find + batch returns the whole batch ordered by sequence ASC', async () => {
    await provider.init();
    const entries = [
      makeEntry({ id: 'a', batchId: 'bx', sequence: 2 }),
      makeEntry({ id: 'b', batchId: 'bx', sequence: 0 }),
      makeEntry({ id: 'c', batchId: 'bx', sequence: 1 }),
    ];
    await provider.store(entries);

    const found = await provider.find('a');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('a');
    expect(found?.batch.map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(found?.batch.map((e) => e.sequence)).toEqual([0, 1, 2]);

    const batch = await provider.batch('bx');
    expect(batch.map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('omitContent projects every column except content, returning content null', async () => {
    await provider.init();
    await provider.store([
      makeEntry({
        id: 'oc',
        type: 'query',
        familyHash: 'q:x',
        durationMs: 77,
        content: { sql: 'select * from huge_table' },
      }),
    ]);
    const { data } = await provider.get({ omitContent: true });
    expect(data).toHaveLength(1);
    expect(data[0]!.content).toBeNull();
    expect(data[0]!.id).toBe('oc');
    expect(data[0]!.type).toBe('query');
    expect(data[0]!.familyHash).toBe('q:x');
    expect(data[0]!.durationMs).toBe(77);
  });

  it('round-trips traceId/spanId, preserving values and null', async () => {
    await provider.init();
    const traceId = 'a'.repeat(32);
    const spanId = 'b'.repeat(16);
    await provider.store([
      makeEntry({ id: 'traced', traceId, spanId }),
      makeEntry({ id: 'untraced', traceId: null, spanId: null }),
    ]);

    const traced = await provider.find('traced');
    expect(traced?.traceId).toBe(traceId);
    expect(traced?.spanId).toBe(spanId);

    const untraced = await provider.find('untraced');
    expect(untraced?.traceId).toBeNull();
    expect(untraced?.spanId).toBeNull();
  });

  it('paginates 120 entries newest-first with zero duplicates (keyset guard)', async () => {
    await provider.init();
    const base = Date.UTC(2024, 0, 1, 0, 0, 0);
    const entries: Entry[] = [];
    for (let i = 0; i < 120; i++) {
      const id = `e${String(i).padStart(3, '0')}`;
      // Force two entries (e050, e051) to share one createdAt to exercise the
      // id-DESC tiebreaker.
      const offset = i === 51 ? 50 : i;
      entries.push(makeEntry({ id, createdAt: new Date(base + offset) }));
    }
    await provider.store(entries);

    const page1 = await provider.get({ limit: 50 });
    expect(page1.data).toHaveLength(50);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await provider.get({ limit: 50, cursor: page1.nextCursor ?? undefined });
    expect(page2.data).toHaveLength(50);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await provider.get({ limit: 50, cursor: page2.nextCursor ?? undefined });
    expect(page3.data).toHaveLength(20);
    expect(page3.nextCursor).toBeNull();

    const all = [...page1.data, ...page2.data, ...page3.data];

    // Total + uniqueness.
    expect(all).toHaveLength(120);
    expect(new Set(all.map((e) => e.id)).size).toBe(120);

    // Global newest-first ordering across the concatenation: createdAt
    // non-increasing, ties broken id-DESC.
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1]!;
      const cur = all[i]!;
      const prevMs = prev.createdAt.getTime();
      const curMs = cur.createdAt.getTime();
      expect(prevMs >= curMs).toBe(true);
      if (prevMs === curMs) {
        expect(prev.id > cur.id).toBe(true);
      }
    }

    // The tie pair must be adjacent and ordered e051 before e050.
    const tieMs = base + 50;
    const tied = all.filter((e) => e.createdAt.getTime() === tieMs).map((e) => e.id);
    expect(tied).toEqual(['e051', 'e050']);
  });

  it('filters by type, tag (space-padded, no substring leak), and before/after', async () => {
    await provider.init();
    const t0 = new Date(Date.UTC(2024, 0, 1));
    const t1 = new Date(Date.UTC(2024, 0, 2));
    const t2 = new Date(Date.UTC(2024, 0, 3));

    await provider.store([
      makeEntry({ id: 'q1', type: 'query', tags: ['slow'], createdAt: t0 }),
      makeEntry({ id: 'r1', type: 'request', tags: ['slowest'], createdAt: t1 }),
      makeEntry({ id: 'q2', type: 'query', tags: ['fast', 'slow'], createdAt: t2 }),
    ]);

    const byType = await provider.get({ type: 'query' });
    expect(byType.data.map((e) => e.id).sort()).toEqual(['q1', 'q2']);

    const byTag = await provider.get({ tag: 'slow' });
    // 'slowest' must NOT match 'slow' (space padding guards substring leaks).
    expect(byTag.data.map((e) => e.id).sort()).toEqual(['q1', 'q2']);

    const afterT0 = await provider.get({ after: t0 });
    expect(afterT0.data.map((e) => e.id).sort()).toEqual(['q2', 'r1']);

    const beforeT2 = await provider.get({ before: t2 });
    expect(beforeT2.data.map((e) => e.id).sort()).toEqual(['q1', 'r1']);
  });

  it('fetches an ids set for batched hydration (AND with type; empty/absent ids)', async () => {
    await provider.init();
    await provider.store([
      makeEntry({ id: 'a', type: 'query', content: { sql: 'select a' } }),
      makeEntry({ id: 'b', type: 'request', content: { uri: '/b' } }),
      makeEntry({ id: 'c', type: 'query', content: { sql: 'select c' } }),
    ]);

    const byIds = await provider.get({ ids: ['a', 'c'] });
    expect(byIds.data.map((e) => e.id).sort()).toEqual(['a', 'c']);
    expect(byIds.data.every((e) => e.content !== null)).toBe(true);

    const byIdsAndType = await provider.get({ ids: ['a', 'b', 'c'], type: 'query' });
    expect(byIdsAndType.data.map((e) => e.id).sort()).toEqual(['a', 'c']);

    const withMissing = await provider.get({ ids: ['a', 'missing'] });
    expect(withMissing.data.map((e) => e.id)).toEqual(['a']);

    expect((await provider.get({ ids: [] })).data).toEqual([]);
  });

  it('free-text searches content via $like (substring), ANDing with type', async () => {
    await provider.init();
    await provider.store([
      makeEntry({ id: 'req', type: 'request', content: { uri: '/api/orders' } }),
      makeEntry({ id: 'sql', type: 'query', content: { sql: 'select * from users' } }),
      makeEntry({ id: 'cache', type: 'cache', content: { key: 'kpi.json' } }),
    ]);

    const byOrders = await provider.get({ search: 'orders' });
    expect(byOrders.data.map((e) => e.id)).toEqual(['req']);

    const noMatch = await provider.get({ search: 'nope' });
    expect(noMatch.data).toEqual([]);

    const typed = await provider.get({ type: 'query', search: 'users' });
    expect(typed.data.map((e) => e.id)).toEqual(['sql']);

    const typedNoMatch = await provider.get({ type: 'request', search: 'users' });
    expect(typedNoMatch.data).toEqual([]);
  });

  it('filters by traceId, excluding other traces and null', async () => {
    await provider.init();
    await provider.store([
      makeEntry({ id: 'a1', traceId: 'trace-A' }),
      makeEntry({ id: 'a2', traceId: 'trace-A' }),
      makeEntry({ id: 'b1', traceId: 'trace-B' }),
      makeEntry({ id: 'none', traceId: null }),
    ]);
    const result = await provider.get({ traceId: 'trace-A' });
    expect(result.data.map((e) => e.id).sort()).toEqual(['a1', 'a2']);
  });

  it('update patches fields, keeps id immutable, and reindexes tags', async () => {
    await provider.init();
    await provider.store([makeEntry({ id: 'u1', durationMs: null, tags: ['old'] })]);

    await provider.update('u1', { durationMs: 1234, tags: ['new'] });

    const found = await provider.find('u1');
    expect(found?.id).toBe('u1');
    expect(found?.durationMs).toBe(1234);
    expect(found?.tags).toEqual(['new']);

    // Old tag no longer matches; new tag does.
    const byOld = await provider.get({ tag: 'old' });
    expect(byOld.data).toHaveLength(0);
    const byNew = await provider.get({ tag: 'new' });
    expect(byNew.data.map((e) => e.id)).toEqual(['u1']);

    // Attempting to change id is ignored (id is immutable in the patch).
    const idPatch: Partial<Entry> = { id: 'hacked' };
    await provider.update('u1', idPatch);
    expect(await provider.find('u1')).not.toBeNull();
    expect(await provider.find('hacked')).toBeNull();

    // Unknown id is a no-op.
    await provider.update('does-not-exist', { durationMs: 9 });
  });

  it('prune deletes only old entries, honoring keepLast', async () => {
    await provider.init();
    const cutoff = new Date(Date.UTC(2024, 0, 10));
    const oldA = new Date(Date.UTC(2024, 0, 1));
    const oldB = new Date(Date.UTC(2024, 0, 2));
    const oldC = new Date(Date.UTC(2024, 0, 3));
    const newA = new Date(Date.UTC(2024, 0, 20));

    async function seed(): Promise<void> {
      await provider.clear();
      await provider.store([
        makeEntry({ id: 'old-a', createdAt: oldA }),
        makeEntry({ id: 'old-b', createdAt: oldB }),
        makeEntry({ id: 'old-c', createdAt: oldC }),
        makeEntry({ id: 'new-a', createdAt: newA }),
      ]);
    }

    await seed();
    const deleted = await provider.prune(cutoff);
    expect(deleted).toBe(3);
    const remaining = await provider.get({});
    expect(remaining.data.map((e) => e.id)).toEqual(['new-a']);

    await seed();
    const deletedKeep = await provider.prune(cutoff, 2);
    // 3 old entries, keep the newest 2 (old-c, old-b) → delete 1 (old-a).
    expect(deletedKeep).toBe(1);
    const afterKeep = await provider.get({});
    expect(afterKeep.data.map((e) => e.id).sort()).toEqual(['new-a', 'old-b', 'old-c']);
  });

  it('tags() returns counts, filtered by prefix', async () => {
    await provider.init();
    await provider.store([
      makeEntry({ id: 't1', tags: ['db.read', 'slow'] }),
      makeEntry({ id: 't2', tags: ['db.write', 'slow'] }),
      makeEntry({ id: 't3', tags: ['http'] }),
    ]);

    const all = await provider.tags();
    const allMap = new Map(all.map((t) => [t.tag, t.count]));
    expect(allMap.get('slow')).toBe(2);
    expect(allMap.get('db.read')).toBe(1);
    expect(allMap.get('db.write')).toBe(1);
    expect(allMap.get('http')).toBe(1);

    const dbTags = await provider.tags('db');
    expect(dbTags.map((t) => t.tag).sort()).toEqual(['db.read', 'db.write']);
    expect(dbTags.every((t) => t.count === 1)).toBe(true);
  });
});

describe('MikroOrmStorageProvider schema self-heal (file sqlite)', () => {
  it('adds a missing column additively, without dropping pre-existing rows', async () => {
    const dbFile = join(tmpdir(), `telescope-additive-${process.pid}.sqlite`);
    rmSync(dbFile, { force: true });
    let provider: MikroOrmStorageProvider | null = null;

    try {
      // Step A: pre-create `telescope_entries` MISSING the `duration_ms` column,
      // and seed a row, using a bare connection (no TelescopeEntry metadata).
      const seedOrm = await MikroORM.init({
        driver: SqliteDriver,
        dbName: dbFile,
        entities: [],
        allowGlobalContext: true,
        discovery: { warnWhenNoEntities: false },
      });
      const conn = seedOrm.em.getConnection();
      await conn.execute(
        'create table `telescope_entries` (`id` text not null primary key, `batch_id` text not null, `type` text not null, `family_hash` text null, `content` json not null, `tags` json not null, `tags_text` text not null, `sequence` integer not null, `origin` text not null, `instance_id` text not null, `created_at` datetime not null)',
      );
      await conn.execute(
        "insert into `telescope_entries` (`id`, `batch_id`, `type`, `family_hash`, `content`, `tags`, `tags_text`, `sequence`, `origin`, `instance_id`, `created_at`) values ('pre', 'bp', 'request', null, '{}', '[]', ' ', 0, 'http', 'i1', '2024-01-01 00:00:00')",
      );
      await seedOrm.close(true);

      // Step B: the provider's init() must ADD `duration_ms` (additive update).
      provider = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
      await provider.init();

      // The pre-existing row survived (no drop) and reads back.
      const pre = await provider.find('pre');
      expect(pre).not.toBeNull();
      expect(pre?.id).toBe('pre');

      // The new column exists and round-trips a value: proves it was added.
      await provider.store([makeEntry({ id: 'post', durationMs: 777 })]);
      const post = await provider.find('post');
      expect(post?.durationMs).toBe(777);
    } finally {
      await provider?.close();
      rmSync(dbFile, { force: true });
    }
  });

  it('adds missing trace columns additively, without dropping pre-existing rows', async () => {
    const dbFile = join(tmpdir(), `telescope-trace-additive-${process.pid}.sqlite`);
    rmSync(dbFile, { force: true });
    let provider: MikroOrmStorageProvider | null = null;

    try {
      // Step A: pre-create `telescope_entries` MISSING the `trace_id`/`span_id`
      // columns, and seed a row, using a bare connection (no TelescopeEntry
      // metadata).
      const seedOrm = await MikroORM.init({
        driver: SqliteDriver,
        dbName: dbFile,
        entities: [],
        allowGlobalContext: true,
        discovery: { warnWhenNoEntities: false },
      });
      const conn = seedOrm.em.getConnection();
      await conn.execute(
        'create table `telescope_entries` (`id` text not null primary key, `batch_id` text not null, `type` text not null, `family_hash` text null, `content` json not null, `tags` json not null, `tags_text` text not null, `sequence` integer not null, `duration_ms` integer null, `origin` text not null, `instance_id` text not null, `created_at` datetime not null)',
      );
      await conn.execute(
        "insert into `telescope_entries` (`id`, `batch_id`, `type`, `family_hash`, `content`, `tags`, `tags_text`, `sequence`, `duration_ms`, `origin`, `instance_id`, `created_at`) values ('pre', 'bp', 'request', null, '{}', '[]', ' ', 0, null, 'http', 'i1', '2024-01-01 00:00:00')",
      );
      await seedOrm.close(true);

      // Step B: the provider's init() must ADD `trace_id`/`span_id` (additive).
      provider = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
      await provider.init();

      // The pre-existing row survived (no drop); its trace fields read as null.
      const pre = await provider.find('pre');
      expect(pre).not.toBeNull();
      expect(pre?.id).toBe('pre');
      expect(pre?.traceId).toBeNull();
      expect(pre?.spanId).toBeNull();

      // The new columns exist and round-trip values: proves they were added.
      await provider.store([
        makeEntry({ id: 'post', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
      ]);
      const post = await provider.find('post');
      expect(post?.traceId).toBe('a'.repeat(32));
      expect(post?.spanId).toBe('b'.repeat(16));
    } finally {
      await provider?.close();
      rmSync(dbFile, { force: true });
    }
  });

  it('leaves host tables untouched: only diffs TelescopeEntry, never the host schema', async () => {
    const dbFile = join(tmpdir(), `telescope-isolation-${process.pid}.sqlite`);
    rmSync(dbFile, { force: true });
    let hostOrm: MikroORM | null = null;
    let provider: MikroOrmStorageProvider | null = null;

    // A host entity whose definition DIFFERS from the actual table: the entity
    // declares a `price` column the real `host_widgets` table does not have.
    // If the provider ever diffed host metadata, schema.update would try to add
    // `price`. It must not.
    interface HostWidgetRow {
      id: number;
      name: string;
      price: number;
    }
    const HostWidget = new EntitySchema<HostWidgetRow>({
      name: 'HostWidget',
      tableName: 'host_widgets',
      properties: {
        id: { type: 'integer', primary: true },
        name: { type: 'string' },
        price: { type: 'integer' },
      },
    });

    try {
      // Pre-create `host_widgets` WITHOUT `price`, seed a row, on a bare conn.
      const seedOrm = await MikroORM.init({
        driver: SqliteDriver,
        dbName: dbFile,
        entities: [],
        allowGlobalContext: true,
        discovery: { warnWhenNoEntities: false },
      });
      const seedConn = seedOrm.em.getConnection();
      await seedConn.execute(
        'create table `host_widgets` (`id` integer not null primary key, `name` text not null)',
      );
      await seedConn.execute("insert into `host_widgets` (`id`, `name`) values (1, 'gadget')");
      await seedOrm.close(true);

      // The host ORM knows ONLY HostWidget (not TelescopeEntry) and points at
      // the same file. The provider derives its connection from this host ORM.
      hostOrm = await MikroORM.init({
        driver: SqliteDriver,
        dbName: dbFile,
        entities: [HostWidget],
        allowGlobalContext: true,
      });

      provider = new MikroOrmStorageProvider(hostOrm);
      await provider.init();

      // telescope_entries now exists (provider created it on the host's db).
      await provider.store([makeEntry({ id: 'iso' })]);
      const page = await provider.get({});
      expect(page.data.map((e) => e.id)).toEqual(['iso']);

      // host_widgets was NOT altered: it still lacks `price`, and its row stands.
      const hostConn = hostOrm.em.getConnection();
      const columns = await hostConn.execute('pragma table_info(`host_widgets`)');
      const columnNames = columns.map((c) => String(c.name));
      expect(columnNames.sort()).toEqual(['id', 'name']);
      expect(columnNames).not.toContain('price');

      const rows = await hostConn.execute('select `id`, `name` from `host_widgets`');
      expect(rows).toEqual([{ id: 1, name: 'gadget' }]);
    } finally {
      await provider?.close();
      await hostOrm?.close(true);
      if (existsSync(dbFile)) rmSync(dbFile, { force: true });
    }
  });
});
