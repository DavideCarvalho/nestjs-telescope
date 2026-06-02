// packages/core/src/storage/in-memory-storage-provider.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from './in-memory-storage-provider.js';

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
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('InMemoryStorageProvider', () => {
  it('stores and finds an entry with its batch', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: '1', batchId: 'b', sequence: 0 }),
      entry({ id: '2', batchId: 'b', type: 'query', sequence: 1 }),
    ]);
    const found = await store.find('1');
    expect(found?.id).toBe('1');
    expect(found?.batch.map((event) => event.id)).toEqual(['1', '2']);
  });

  it('filters by type and tag', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: '1', type: 'request', tags: ['status:200'] }),
      entry({ id: '2', type: 'query', tags: ['slow'] }),
    ]);
    expect((await store.get({ type: 'query' })).data.map((e) => e.id)).toEqual(['2']);
    expect((await store.get({ tag: 'slow' })).data.map((e) => e.id)).toEqual(['2']);
  });

  it('paginates newest-first with a cursor', async () => {
    const store = new InMemoryStorageProvider();
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

  it('filters by empty-string type (falsy-but-present value)', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: '1', type: '' }),
      entry({ id: '2', type: 'request' }),
    ]);
    const result = await store.get({ type: '' });
    expect(result.data.map((e) => e.id)).toEqual(['1']);
  });

  it('returns empty page for a stale cursor that no longer exists', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([entry({ id: '1' }), entry({ id: '2' })]);
    const result = await store.get({ cursor: 'does-not-exist' });
    expect(result).toEqual({ data: [], nextCursor: null });
  });

  it('aggregates tag counts and prunes by age', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: '1', tags: ['slow'], createdAt: new Date('2026-01-01T00:00:00Z') }),
      entry({ id: '2', tags: ['slow'], createdAt: new Date('2026-02-01T00:00:00Z') }),
    ]);
    expect(await store.tags()).toContainEqual({ tag: 'slow', count: 2 });
    const removed = await store.prune(new Date('2026-01-15T00:00:00Z'));
    expect(removed).toBe(1);
    expect((await store.get({})).data.map((e) => e.id)).toEqual(['2']);
  });
});
