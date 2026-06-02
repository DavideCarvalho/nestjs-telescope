// packages/core/src/storage/sqlite-storage-provider.spec.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { SqliteStorageProvider } from './sqlite-storage-provider.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'id', batchId: 'b', type: 'request', familyHash: null, content: {},
    tags: [], sequence: 0, durationMs: null, origin: 'http', instanceId: 'i',
    createdAt: new Date('2026-01-01T00:00:00Z'), ...over,
  };
}

describe('SqliteStorageProvider', () => {
  let store: SqliteStorageProvider;
  beforeEach(() => { store = new SqliteStorageProvider({ path: ':memory:' }); });
  afterEach(() => { store.close(); });

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
    const page2 = await store.get({ limit: 2, ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}) });
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

  it('update patches fields but never the id', async () => {
    await store.store([entry({ id: '1', durationMs: null })]);
    await store.update('1', { durationMs: 42, id: 'hacked' });
    const found = await store.find('1');
    expect(found?.id).toBe('1');
    expect(found?.durationMs).toBe(42);
  });
});
