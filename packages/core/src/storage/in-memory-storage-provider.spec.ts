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
    traceId: null,
    spanId: null,
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

  it('round-trips traceId/spanId through store → find', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: 'traced', traceId: 't', spanId: 's' }),
      entry({ id: 'untraced', traceId: null, spanId: null }),
    ]);

    const traced = await store.find('traced');
    expect(traced?.traceId).toBe('t');
    expect(traced?.spanId).toBe('s');

    const untraced = await store.find('untraced');
    expect(untraced?.traceId).toBeNull();
    expect(untraced?.spanId).toBeNull();
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

  it('free-text searches the entry content (case-insensitive substring), ANDing with type', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: 'req', type: 'request', content: { uri: '/api/orders' } }),
      entry({ id: 'sql', type: 'query', content: { sql: 'select * from users' } }),
      entry({ id: 'cache', type: 'cache', content: { key: 'kpi.json' } }),
    ]);

    expect((await store.get({ search: 'orders' })).data.map((e) => e.id)).toEqual(['req']);
    // case-insensitive
    expect((await store.get({ search: 'ORDERS' })).data.map((e) => e.id)).toEqual(['req']);
    // no match → empty
    expect((await store.get({ search: 'nope' })).data).toEqual([]);
    // ANDs with type: only the query whose sql matches
    expect((await store.get({ type: 'query', search: 'users' })).data.map((e) => e.id)).toEqual([
      'sql',
    ]);
    expect((await store.get({ type: 'request', search: 'users' })).data).toEqual([]);
  });

  it('omitContent returns entries with content null and other fields intact', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: '1', type: 'query', durationMs: 12, content: { sql: 'select 1' } }),
    ]);
    const { data } = await store.get({ omitContent: true });
    expect(data).toHaveLength(1);
    expect(data[0]!.content).toBeNull();
    expect(data[0]!.id).toBe('1');
    expect(data[0]!.type).toBe('query');
    expect(data[0]!.durationMs).toBe(12);
  });

  it('filters by traceId, excluding other traces and null', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: 'a1', traceId: 'trace-A' }),
      entry({ id: 'a2', traceId: 'trace-A' }),
      entry({ id: 'b1', traceId: 'trace-B' }),
      entry({ id: 'none', traceId: null }),
    ]);
    const result = await store.get({ traceId: 'trace-A' });
    expect(result.data.map((e) => e.id).sort()).toEqual(['a1', 'a2']);
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
    const page2 = await store.get({
      limit: 2,
      ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}),
    });
    expect(page2.data.map((e) => e.id)).toEqual(['1']);
    expect(page2.nextCursor).toBeNull();
  });

  it('filters by empty-string type (falsy-but-present value)', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([entry({ id: '1', type: '' }), entry({ id: '2', type: 'request' })]);
    const result = await store.get({ type: '' });
    expect(result.data.map((e) => e.id)).toEqual(['1']);
  });

  it('resumes from keyset position when cursor entry has been pruned', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: '1', createdAt: new Date('2026-01-01T00:00:01Z') }),
      entry({ id: '2', createdAt: new Date('2026-01-01T00:00:02Z') }),
      entry({ id: '3', createdAt: new Date('2026-01-01T00:00:03Z') }),
    ]);
    // Page 1 returns [3, 2]; cursor encodes the keyset position of entry "2"
    const page1 = await store.get({ limit: 2 });
    expect(page1.data.map((e) => e.id)).toEqual(['3', '2']);
    expect(page1.nextCursor).not.toBeNull();

    // Simulate a pruner removing entry "2" (the cursor's own entry) but leaving "1"
    await store.clear();
    await store.store([
      entry({ id: '1', createdAt: new Date('2026-01-01T00:00:01Z') }),
      entry({ id: '3', createdAt: new Date('2026-01-01T00:00:03Z') }),
    ]);

    // Page 2 with the stale cursor must RESUME from keyset (t=02Z, id="2") and return ["1"]
    const page2 = await store.get({
      limit: 2,
      ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}),
    });
    expect(page2.data.map((e) => e.id)).toEqual(['1']);
    expect(page2.nextCursor).toBeNull();
  });

  it('falls back to DEFAULT_LIMIT when limit is NaN', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([entry({ id: '1' }), entry({ id: '2' })]);
    const page = await store.get({ limit: Number.NaN });
    expect(page.data).toHaveLength(2);
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
