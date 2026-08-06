// packages/core/src/storage/sqlite-storage-provider.spec.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { SqliteStorageProvider } from './sqlite-storage-provider.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'id',
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('SqliteStorageProvider', () => {
  let store: SqliteStorageProvider;
  beforeEach(() => {
    store = new SqliteStorageProvider({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  it('stores and finds an entry with its batch (sequence-ordered)', async () => {
    await store.store([
      entry({ id: '1', batchId: 'b', sequence: 0, content: { a: 1 } }),
      entry({ id: '2', batchId: 'b', type: 'query', sequence: 1 }),
    ]);
    const found = await store.find('1');
    expect(found?.id).toBe('1');
    expect((found?.content as { a: number }).a).toBe(1);
    expect(found?.batch.map((e) => e.id)).toEqual(['1', '2']);
  });

  it('filters by type and tag (json_each)', async () => {
    await store.store([
      entry({ id: '1', type: 'request', tags: ['status:200'] }),
      entry({ id: '2', type: 'query', tags: ['slow'] }),
    ]);
    expect((await store.get({ type: 'query' })).data.map((e) => e.id)).toEqual(['2']);
    expect((await store.get({ tag: 'slow' })).data.map((e) => e.id)).toEqual(['2']);
  });

  it('free-text searches content via LIKE (case-insensitive substring), ANDing with type', async () => {
    await store.store([
      entry({ id: 'req', type: 'request', content: { uri: '/api/orders' } }),
      entry({ id: 'sql', type: 'query', content: { sql: 'select * from users' } }),
      entry({ id: 'cache', type: 'cache', content: { key: 'kpi.json' } }),
    ]);

    expect((await store.get({ search: 'orders' })).data.map((e) => e.id)).toEqual(['req']);
    expect((await store.get({ search: 'ORDERS' })).data.map((e) => e.id)).toEqual(['req']);
    expect((await store.get({ search: 'nope' })).data).toEqual([]);
    expect((await store.get({ type: 'query', search: 'users' })).data.map((e) => e.id)).toEqual([
      'sql',
    ]);
    expect((await store.get({ type: 'request', search: 'users' })).data).toEqual([]);
  });

  it('omitContent returns entries with content null and other fields intact', async () => {
    await store.store([
      entry({
        id: '1',
        type: 'query',
        familyHash: 'q:x',
        durationMs: 42,
        content: { sql: 'select * from huge' },
      }),
    ]);
    const { data } = await store.get({ omitContent: true });
    expect(data).toHaveLength(1);
    expect(data[0]!.content).toBeNull();
    expect(data[0]!.id).toBe('1');
    expect(data[0]!.type).toBe('query');
    expect(data[0]!.familyHash).toBe('q:x');
    expect(data[0]!.durationMs).toBe(42);
  });

  it('filters by an ids set for batched hydration (AND with type; empty/absent ids)', async () => {
    await store.store([
      entry({ id: 'a', type: 'query', content: { sql: 'select a' } }),
      entry({ id: 'b', type: 'request', content: { uri: '/b' } }),
      entry({ id: 'c', type: 'query', content: { sql: 'select c' } }),
    ]);

    const byIds = await store.get({ ids: ['a', 'c'] });
    expect(byIds.data.map((e) => e.id).sort()).toEqual(['a', 'c']);
    expect(byIds.data.every((e) => e.content !== null)).toBe(true);

    const byIdsAndType = await store.get({ ids: ['a', 'b', 'c'], type: 'query' });
    expect(byIdsAndType.data.map((e) => e.id).sort()).toEqual(['a', 'c']);

    const withMissing = await store.get({ ids: ['a', 'missing'] });
    expect(withMissing.data.map((e) => e.id)).toEqual(['a']);

    expect((await store.get({ ids: [] })).data).toEqual([]);
  });

  it('filters by traceId, excluding other traces and null', async () => {
    await store.store([
      entry({ id: 'a1', traceId: 'trace-A' }),
      entry({ id: 'a2', traceId: 'trace-A' }),
      entry({ id: 'b1', traceId: 'trace-B' }),
      entry({ id: 'none', traceId: null }),
    ]);
    const result = await store.get({ traceId: 'trace-A' });
    expect(result.data.map((e) => e.id).sort()).toEqual(['a1', 'a2']);
  });

  it('paginates newest-first with an opaque cursor', async () => {
    await store.store([
      entry({ id: '1', createdAt: new Date('2026-01-01T00:00:01Z') }),
      entry({ id: '2', createdAt: new Date('2026-01-01T00:00:02Z') }),
      entry({ id: '3', createdAt: new Date('2026-01-01T00:00:03Z') }),
    ]);
    const page1 = await store.get({ limit: 2 });
    expect(page1.data.map((e) => e.id)).toEqual(['3', '2']);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await store.get({
      limit: 2,
      ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}),
    });
    expect(page2.data.map((e) => e.id)).toEqual(['1']);
    expect(page2.nextCursor).toBeNull();
  });

  it('aggregates tag counts and prunes by age', async () => {
    await store.store([
      entry({ id: '1', tags: ['slow'], createdAt: new Date('2026-01-01T00:00:00Z') }),
      entry({ id: '2', tags: ['slow'], createdAt: new Date('2026-02-01T00:00:00Z') }),
    ]);
    expect(await store.tags()).toContainEqual({ tag: 'slow', count: 2 });
    expect(await store.prune(new Date('2026-01-15T00:00:00Z'))).toBe(1);
    expect((await store.get({})).data.map((e) => e.id)).toEqual(['2']);
  });

  describe('markFamilySeen (shared new-exception dedup)', () => {
    it('returns true once for a brand-new family, false on a repeat in window', async () => {
      const now = 1_000_000;
      expect(await store.markFamilySeen('fam', now, 60_000)).toBe(true);
      expect(await store.markFamilySeen('fam', now + 1_000, 60_000)).toBe(false);
    });

    it('returns true again once the family is older than the window', async () => {
      const now = 1_000_000;
      expect(await store.markFamilySeen('fam', now, 60_000)).toBe(true);
      expect(await store.markFamilySeen('fam', now + 60_001, 60_000)).toBe(true);
    });

    it('serializes concurrent writers so only one sees a new family', async () => {
      // Two markFamilySeen calls on the same store (same db) for a new family —
      // exactly one must return true (the atomic check-and-update).
      const now = 2_000_000;
      const [a, b] = await Promise.all([
        store.markFamilySeen('race', now, 60_000),
        store.markFamilySeen('race', now, 60_000),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });
  });

  describe('pruneScoped', () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const fresh = new Date('2026-03-01T00:00:00Z');
    const cutoff = new Date('2026-02-01T00:00:00Z');

    async function seed(): Promise<void> {
      await store.store([
        entry({ id: 'req-old', type: 'request', createdAt: old }),
        entry({ id: 'req-new', type: 'request', createdAt: fresh }),
        entry({ id: 'exc-old', type: 'exception', createdAt: old }),
        entry({ id: 'job-old', type: 'job', createdAt: old }),
      ]);
    }

    it('prunes ONLY the named type (WHERE created_at < ? AND type = ?)', async () => {
      await seed();
      expect(await store.pruneScoped({ before: cutoff, type: 'exception' })).toBe(1);
      expect((await store.get({})).data.map((e) => e.id).sort()).toEqual([
        'job-old',
        'req-new',
        'req-old',
      ]);
    });

    it('excludeTypes carves out the overridden types (type NOT IN (...))', async () => {
      await seed();
      expect(await store.pruneScoped({ before: cutoff, excludeTypes: ['exception'] })).toBe(2);
      expect((await store.get({})).data.map((e) => e.id).sort()).toEqual(['exc-old', 'req-new']);
    });

    it('keepLast spares the newest N in-scope rows', async () => {
      await store.store([
        entry({ id: 'e1', type: 'exception', createdAt: new Date('2026-01-01T00:00:00Z') }),
        entry({ id: 'e2', type: 'exception', createdAt: new Date('2026-01-02T00:00:00Z') }),
      ]);
      expect(await store.pruneScoped({ before: cutoff, type: 'exception', keepLast: 1 })).toBe(1);
      expect((await store.get({})).data.map((e) => e.id)).toEqual(['e2']);
    });
  });

  describe('pruneScopedBatch', () => {
    const cutoff = new Date('2026-02-01T00:00:00Z');

    /** `count` doomed rows, each a minute older than the last. */
    async function seedOld(count: number, type = 'request'): Promise<void> {
      const base = Date.parse('2026-01-01T00:00:00Z');
      await store.store(
        Array.from({ length: count }, (_unused, index) =>
          entry({ id: `e${index}`, type, createdAt: new Date(base + index * 60_000) }),
        ),
      );
    }

    it('deletes at most `limit` rows and reports that more remain', async () => {
      await seedOld(5);
      // The bound is the whole point: one call must never turn into the
      // unbounded delete this replaces.
      expect(await store.pruneScopedBatch({ before: cutoff, limit: 2 })).toEqual({
        deleted: 2,
        hasMore: true,
      });
      expect((await store.get({})).data).toHaveLength(3);
    });

    it('deletes OLDEST first', async () => {
      await seedOld(3);
      await store.pruneScopedBatch({ before: cutoff, limit: 2 });
      // e0/e1 are the oldest; the survivor must be the newest of the doomed set,
      // so that a partial cycle still lowers the age of the oldest entry.
      expect((await store.get({})).data.map((row) => row.id)).toEqual(['e2']);
    });

    it('reports hasMore false once the scope is drained', async () => {
      await seedOld(2);
      expect(await store.pruneScopedBatch({ before: cutoff, limit: 10 })).toEqual({
        deleted: 2,
        hasMore: false,
      });
    });

    it('honours the type selectors exactly as pruneScoped does', async () => {
      await store.store([
        entry({ id: 'req', type: 'request', createdAt: new Date('2026-01-01T00:00:00Z') }),
        entry({ id: 'exc', type: 'exception', createdAt: new Date('2026-01-01T00:00:00Z') }),
        entry({ id: 'fresh', type: 'request', createdAt: new Date('2026-03-01T00:00:00Z') }),
      ]);
      expect(
        await store.pruneScopedBatch({ before: cutoff, excludeTypes: ['exception'], limit: 10 }),
      ).toEqual({ deleted: 1, hasMore: false });
      expect((await store.get({})).data.map((row) => row.id).sort()).toEqual(['exc', 'fresh']);
    });

    it('a loop of bounded batches deletes exactly what one unbounded prune would', async () => {
      await seedOld(7);
      let deleted = 0;
      for (;;) {
        const result = await store.pruneScopedBatch({ before: cutoff, limit: 3 });
        deleted += result.deleted;
        if (!result.hasMore) break;
      }
      expect(deleted).toBe(7);
      expect((await store.get({})).data).toHaveLength(0);
    });
  });

  describe('lease SPI', () => {
    it('grants to one owner, refuses another, and re-grants after release', async () => {
      const now = Date.now();
      expect(await store.tryAcquireLease('telescope:prune', 'pod-a', 60_000, now)).toBe(true);
      expect(await store.tryAcquireLease('telescope:prune', 'pod-b', 60_000, now)).toBe(false);
      // Re-entrant for the same owner, so a restart is not locked out by itself.
      expect(await store.tryAcquireLease('telescope:prune', 'pod-a', 60_000, now)).toBe(true);

      await store.releaseLease('telescope:prune', 'pod-a');
      expect(await store.tryAcquireLease('telescope:prune', 'pod-b', 60_000, now)).toBe(true);
    });

    it('re-grants an expired lease, so a crashed holder cannot wedge the fleet', async () => {
      const now = Date.now();
      expect(await store.tryAcquireLease('telescope:prune', 'pod-a', 1_000, now)).toBe(true);
      expect(await store.tryAcquireLease('telescope:prune', 'pod-b', 1_000, now + 500)).toBe(false);
      expect(await store.tryAcquireLease('telescope:prune', 'pod-b', 1_000, now + 1_500)).toBe(
        true,
      );
    });

    it('ignores a release from an owner that no longer holds the lease', async () => {
      const now = Date.now();
      await store.tryAcquireLease('telescope:prune', 'pod-a', 1_000, now);
      await store.tryAcquireLease('telescope:prune', 'pod-b', 60_000, now + 2_000);

      // The stale holder finally releases; it must not hand pod-b's lease away.
      await store.releaseLease('telescope:prune', 'pod-a');
      expect(await store.tryAcquireLease('telescope:prune', 'pod-c', 60_000, now + 3_000)).toBe(
        false,
      );
    });
  });

  it('falls back to DEFAULT_LIMIT when limit is NaN', async () => {
    await store.store([entry({ id: '1' }), entry({ id: '2' })]);
    const page = await store.get({ limit: Number.NaN });
    expect(page.data).toHaveLength(2);
  });

  it('update patches fields but never the id', async () => {
    await store.store([entry({ id: '1', durationMs: null })]);
    await store.update('1', { durationMs: 42, id: 'hacked' });
    const found = await store.find('1');
    expect(found?.id).toBe('1');
    expect(found?.durationMs).toBe(42);
  });

  it('round-trips an entry with empty tags and object content without data loss', async () => {
    const original = entry({ id: 'rt1', tags: [], content: { nested: { value: true } } });
    await store.store([original]);
    const found = await store.find('rt1');
    expect(found?.tags).toEqual([]);
    expect(found?.content).toEqual({ nested: { value: true } });
  });

  it('round-trips traceId/spanId and persists null when absent', async () => {
    await store.store([
      entry({ id: 'with-trace', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
      entry({ id: 'no-trace', traceId: null, spanId: null }),
    ]);
    const withTrace = await store.find('with-trace');
    expect(withTrace?.traceId).toBe('a'.repeat(32));
    expect(withTrace?.spanId).toBe('b'.repeat(16));
    const noTrace = await store.find('no-trace');
    expect(noTrace?.traceId).toBeNull();
    expect(noTrace?.spanId).toBeNull();
  });
});

describe('SqliteStorageProvider additive trace-column guard', () => {
  let dir: string;
  let dbPath: string;
  let provider: SqliteStorageProvider | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'telescope-sqlite-'));
    dbPath = join(dir, 'pre-existing.db');
  });

  afterEach(() => {
    provider?.close();
    provider = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds trace_id/span_id to a pre-existing table that predates the columns', async () => {
    // Seed a file-backed table with the OLD schema: every current column EXCEPT
    // trace_id and span_id. The provider must self-heal this on construction.
    const seed = new Database(dbPath);
    seed.exec(`
      create table telescope_entries (
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
    `);
    const columnsBefore = seed
      .prepare('select name from pragma_table_info(?)')
      .all('telescope_entries')
      .map((row) => (row as { name: string }).name);
    expect(columnsBefore).not.toContain('trace_id');
    expect(columnsBefore).not.toContain('span_id');
    seed.close();

    // Schema self-heal (adding trace_id/span_id) runs synchronously in the
    // constructor — SqliteStorageProvider has no separate async init() step.
    provider = new SqliteStorageProvider({ path: dbPath });

    await provider.store([
      entry({ id: 'healed', traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) }),
    ]);
    const found = await provider.find('healed');
    expect(found?.traceId).toBe('c'.repeat(32));
    expect(found?.spanId).toBe('d'.repeat(16));
  });

  it('indexes trace_id even on a legacy table (the index DDL runs after the column self-heals)', () => {
    // OLD schema without trace_id/span_id — same legacy seed as above.
    const seed = new Database(dbPath);
    seed.exec(`
      create table telescope_entries (
        id text primary key, batch_id text not null, type text not null,
        family_hash text, content text not null, tags text not null,
        sequence integer not null, duration_ms integer, origin text not null,
        instance_id text not null, created_at integer not null
      );
    `);
    seed.close();

    // Construction must add trace_id then create ix_te_trace — never throw on the
    // missing column (the bug this guards: indexing trace_id before it exists).
    provider = new SqliteStorageProvider({ path: dbPath });

    const inspect = new Database(dbPath, { readonly: true });
    const indexes = inspect
      .prepare('select name from pragma_index_list(?)')
      .all('telescope_entries')
      .map((row) => (row as { name: string }).name);
    inspect.close();
    expect(indexes).toContain('ix_te_trace');
  });
});
