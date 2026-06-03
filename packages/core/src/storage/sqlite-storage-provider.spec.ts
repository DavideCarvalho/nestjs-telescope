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

    provider = new SqliteStorageProvider({ path: dbPath });
    await provider.init?.();

    await provider.store([entry({ id: 'healed', traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) })]);
    const found = await provider.find('healed');
    expect(found?.traceId).toBe('c'.repeat(32));
    expect(found?.spanId).toBe('d'.repeat(16));
  });
});
