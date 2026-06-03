// packages/mikro-orm/src/mikro-orm-storage.provider.integration.spec.ts
//
// Integration: real MikroORM with the in-memory SqliteDriver. Each test gets a
// fresh ORM + schema so identity maps and tables never leak between cases.
//
// The headline guard is the 120-entry keyset pagination test: it proves the
// provider walks the entire result set newest-first with zero duplicates/gaps,
// including the createdAt-tie / id-DESC tiebreaker path.
//
import type { Entry } from '@dudousxd/nestjs-telescope';
import { MikroORM } from '@mikro-orm/core';
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
    createdAt: new Date(),
    ...overrides,
  };
}

describe('MikroOrmStorageProvider integration (sqlite :memory:)', () => {
  let orm: MikroORM;
  let provider: MikroOrmStorageProvider;

  beforeEach(async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [TelescopeEntry],
      allowGlobalContext: true,
    });
    await orm.schema.create();
    provider = new MikroOrmStorageProvider(orm.em);
  });

  afterEach(async () => {
    await orm.close(true);
  });

  it('store + find + batch returns the whole batch ordered by sequence ASC', async () => {
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

  it('paginates 120 entries newest-first with zero duplicates (keyset guard)', async () => {
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

  it('update patches fields, keeps id immutable, and reindexes tags', async () => {
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
