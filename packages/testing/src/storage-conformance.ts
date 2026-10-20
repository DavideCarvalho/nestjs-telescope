import type {
  Entry,
  RollupDelta,
  RollupStore,
  StorageProvider,
  TagCount,
} from '@dudousxd/nestjs-telescope';
import { HISTOGRAM_BUCKET_COUNT, isRollupStore } from '@dudousxd/nestjs-telescope';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

export interface StorageConformanceOptions {
  /**
   * Runs after every store() a READ test uses to seed its data. A composite store uses it to
   * move part of what was just stored somewhere else — `tieredStorage` archives the older half
   * to its cold tier — so the read assertions also cover data that lives behind the boundary.
   * Write tests (`update`, `prune*`, leases) never call it: those operations target the
   * provider's primary store by contract.
   */
  afterSeed?: (provider: StorageProvider, seeded: Entry[]) => Promise<void>;
  /**
   * How the provider expires data. `'delete'` (the default) asserts the `prune*` methods delete
   * what they say they delete. `'ttl'` is for stores whose retention is the database's own TTL:
   * `prune*` must then be no-ops that report zero and leave every entry in place.
   */
  retention?: 'delete' | 'ttl';
  /** Releases the provider after each test. Defaults to `provider.close?.()`. */
  teardown?: (provider: StorageProvider) => void | Promise<void>;
  /** When set, the whole suite is registered as skipped, with this as the reason. */
  skip?: string;
  /** Per-test timeout for stores that talk to a real server. */
  timeoutMs?: number;
}

const SECOND = 1000;

/**
 * Registers the `StorageProvider` contract as a Vitest suite. Every test gets a fresh provider
 * from `factory`, initialised and cleared, so a factory may hand back the same instance each
 * time (e.g. one connection to a container) as long as `clear()` empties it.
 *
 * Optional SPI members (`pruneScoped`, `pruneScopedBatch`, the lease pair, `markFamilySeen`, the
 * rollup pair) are only exercised when the provider has them; a provider that omits one is not
 * failed for it.
 */
export function describeStorageProvider(
  name: string,
  factory: () => StorageProvider | Promise<StorageProvider>,
  options: StorageConformanceOptions = {},
): void {
  const suite = options.skip !== undefined ? describe.skip : describe;
  const title =
    options.skip !== undefined
      ? `StorageProvider conformance: ${name} (skipped: ${options.skip})`
      : `StorageProvider conformance: ${name}`;

  suite(title, { timeout: options.timeoutMs ?? 30_000 }, () => {
    let provider: StorageProvider;
    // Whole seconds, two hours back: inside any sane retention window, and far enough from
    // "now" that a store partitioning by hour never sees a test straddle the current hour.
    const base = Math.floor((Date.now() - 2 * 60 * 60 * SECOND) / SECOND) * SECOND;
    const at = (offsetSeconds: number): Date => new Date(base + offsetSeconds * SECOND);
    const ttl = options.retention === 'ttl';

    const seed = async (entries: Entry[]): Promise<void> => {
      await provider.store(entries);
      await options.afterSeed?.(provider, entries);
    };

    const all = async (query: Parameters<StorageProvider['get']>[0] = {}): Promise<Entry[]> => {
      const out: Entry[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 1000; page += 1) {
        const result = await provider.get({ ...query, ...(cursor ? { cursor } : {}) });
        out.push(...result.data);
        if (result.nextCursor === null) return out;
        cursor = result.nextCursor;
      }
      throw new Error('pagination did not terminate');
    };

    const ids = (entries: Entry[]): string[] => entries.map((entry) => entry.id);

    beforeEach(async () => {
      provider = await factory();
      await provider.init?.();
      await provider.clear();
    });

    afterEach(async () => {
      if (options.teardown) await options.teardown(provider);
      else await provider.close?.();
    });

    describe('store / find', () => {
      it('round-trips every field', async () => {
        const original = makeEntry({
          id: 'e-0001',
          batchId: 'batch-a',
          type: 'query',
          familyHash: 'fam-1',
          content: { sql: 'select 1', bindings: [1, 'two'], nested: { ok: true } },
          tags: ['slow', 'user:42'],
          sequence: 3,
          durationMs: 125,
          origin: 'queue',
          instanceId: 'pod-1',
          traceId: 'trace-1',
          spanId: 'span-1',
          createdAt: at(10),
        });
        await seed([original]);

        const found = await provider.find('e-0001');
        expect(found).not.toBeNull();
        const { batch, ...entry } = found as NonNullable<typeof found>;
        expect(entry.createdAt).toBeInstanceOf(Date);
        expect(entry).toEqual(original);
        expect(ids(batch)).toEqual(['e-0001']);
      });

      it('round-trips nulls and empty tags', async () => {
        const original = makeEntry({ id: 'e-0001', createdAt: at(1) });
        await seed([original]);
        const found = await provider.find('e-0001');
        expect(found?.familyHash).toBeNull();
        expect(found?.durationMs).toBeNull();
        expect(found?.traceId).toBeNull();
        expect(found?.spanId).toBeNull();
        expect(found?.tags).toEqual([]);
      });

      it('returns null for an unknown id', async () => {
        await seed([makeEntry({ id: 'e-0001', createdAt: at(1) })]);
        expect(await provider.find('missing')).toBeNull();
      });

      it("returns the entry's batch ordered by sequence", async () => {
        await seed([
          makeEntry({ id: 'e-0003', batchId: 'b1', sequence: 2, createdAt: at(3) }),
          makeEntry({ id: 'e-0001', batchId: 'b1', sequence: 0, createdAt: at(1) }),
          makeEntry({ id: 'e-0002', batchId: 'b1', sequence: 1, createdAt: at(2) }),
          makeEntry({ id: 'e-0004', batchId: 'b2', sequence: 0, createdAt: at(4) }),
        ]);
        const found = await provider.find('e-0002');
        expect(found?.id).toBe('e-0002');
        expect(ids(found?.batch ?? [])).toEqual(['e-0001', 'e-0002', 'e-0003']);
      });

      it('accepts an empty store() call', async () => {
        await provider.store([]);
        expect((await provider.get({})).data).toEqual([]);
      });
    });

    describe('get: order and paging', () => {
      it('returns newest first, ties broken by id descending', async () => {
        await seed([
          makeEntry({ id: 'e-0001', createdAt: at(1) }),
          makeEntry({ id: 'e-0003', createdAt: at(2) }),
          makeEntry({ id: 'e-0002', createdAt: at(2) }),
          makeEntry({ id: 'e-0004', createdAt: at(3) }),
        ]);
        const page = await provider.get({});
        expect(ids(page.data)).toEqual(['e-0004', 'e-0003', 'e-0002', 'e-0001']);
        expect(page.nextCursor).toBeNull();
      });

      it('defaults the page size to 50', async () => {
        await seed(series(60, (i) => ({ createdAt: at(i) })));
        const page = await provider.get({});
        expect(page.data).toHaveLength(50);
        expect(page.nextCursor).not.toBeNull();
      });

      it('pages through every entry exactly once, in order', async () => {
        const entries = series(23, (i) => ({ createdAt: at(Math.floor(i / 3)) }));
        await seed(entries);
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await provider.get({ limit: 5, ...(cursor ? { cursor } : {}) });
          expect(page.data.length).toBeLessThanOrEqual(5);
          seen.push(...ids(page.data));
          cursor = page.nextCursor ?? undefined;
          pages += 1;
        } while (cursor !== undefined && pages < 20);
        expect(seen).toEqual(ids(sortNewestFirst(entries)));
        expect(pages).toBe(5);
      });

      it('has no next cursor when the last page is exactly full', async () => {
        await seed(series(4, (i) => ({ createdAt: at(i) })));
        const first = await provider.get({ limit: 2 });
        expect(first.nextCursor).not.toBeNull();
        const second = await provider.get({ limit: 2, cursor: first.nextCursor as string });
        expect(ids(second.data)).toEqual(['e-0001', 'e-0000']);
        expect(second.nextCursor).toBeNull();
      });

      it('resumes from the cursor position when the cursor entry is gone', async () => {
        const entries = series(5, (i) => ({ createdAt: at(i) }));
        await seed(entries);
        const first = await provider.get({ limit: 2 });
        expect(ids(first.data)).toEqual(['e-0004', 'e-0003']);
        // Rebuild the store without the entry the cursor points at.
        await provider.clear();
        await seed(entries.filter((entry) => entry.id !== 'e-0003'));
        const next = await provider.get({ limit: 2, cursor: first.nextCursor as string });
        expect(ids(next.data)).toEqual(['e-0002', 'e-0001']);
      });

      it('ignores an undecodable cursor', async () => {
        await seed(series(3, (i) => ({ createdAt: at(i) })));
        const page = await provider.get({ cursor: 'not a cursor' });
        expect(ids(page.data)).toEqual(['e-0002', 'e-0001', 'e-0000']);
      });

      it('keeps keyset paging stable across concurrent inserts', async () => {
        await seed(series(6, (i) => ({ createdAt: at(10 + i) })));
        const first = await provider.get({ limit: 3 });
        expect(ids(first.data)).toEqual(['e-0005', 'e-0004', 'e-0003']);

        // One entry newer than everything (must not appear behind the cursor) and one older
        // than everything (must, since it is strictly older than the cursor position).
        await provider.store([
          makeEntry({ id: 'e-0100', createdAt: at(100) }),
          makeEntry({ id: 'e-0099', createdAt: at(0) }),
        ]);
        const rest: string[] = [];
        let cursor = first.nextCursor;
        while (cursor !== null) {
          const page = await provider.get({ limit: 3, cursor });
          rest.push(...ids(page.data));
          cursor = page.nextCursor;
        }
        expect(rest).toEqual(['e-0002', 'e-0001', 'e-0000', 'e-0099']);
      });

      it('returns strictly older entries for a cursor on a timestamp tie', async () => {
        await seed([
          makeEntry({ id: 'e-0001', createdAt: at(5) }),
          makeEntry({ id: 'e-0002', createdAt: at(5) }),
          makeEntry({ id: 'e-0003', createdAt: at(5) }),
          makeEntry({ id: 'e-0000', createdAt: at(4) }),
        ]);
        const first = await provider.get({ limit: 2 });
        expect(ids(first.data)).toEqual(['e-0003', 'e-0002']);
        const second = await provider.get({ limit: 2, cursor: first.nextCursor as string });
        expect(ids(second.data)).toEqual(['e-0001', 'e-0000']);
      });
    });

    describe('get: filters', () => {
      const fixture = (): Entry[] => [
        makeEntry({
          id: 'e-0001',
          type: 'request',
          batchId: 'b1',
          tags: ['status:200'],
          familyHash: null,
          traceId: 't1',
          content: { uri: '/Users/Profile' },
          createdAt: at(1),
        }),
        makeEntry({
          id: 'e-0002',
          type: 'query',
          batchId: 'b1',
          sequence: 1,
          tags: ['slow'],
          familyHash: 'f1',
          traceId: 't1',
          content: { sql: 'SELECT * FROM users' },
          createdAt: at(2),
        }),
        makeEntry({
          id: 'e-0003',
          type: 'query',
          batchId: 'b2',
          tags: ['slow', 'user:7'],
          familyHash: 'f1',
          traceId: 't2',
          content: { sql: 'select * from orders' },
          createdAt: at(3),
        }),
        makeEntry({
          id: 'e-0004',
          type: 'exception',
          batchId: 'b2',
          sequence: 1,
          tags: ['failed'],
          familyHash: 'f2',
          content: { message: 'Boom in Users' },
          createdAt: at(4),
        }),
      ];

      const cases: Array<[string, Parameters<StorageProvider['get']>[0], string[]]> = [
        ['type', { type: 'query' }, ['e-0003', 'e-0002']],
        ['tag', { tag: 'slow' }, ['e-0003', 'e-0002']],
        ['tag (exact, not substring)', { tag: 'user' }, []],
        ['familyHash', { familyHash: 'f1' }, ['e-0003', 'e-0002']],
        ['batchId', { batchId: 'b2' }, ['e-0004', 'e-0003']],
        ['traceId', { traceId: 't1' }, ['e-0002', 'e-0001']],
        [
          'search (case-insensitive substring of content)',
          { search: 'users' },
          ['e-0004', 'e-0002', 'e-0001'],
        ],
        ['ids', { ids: ['e-0004', 'e-0001', 'missing'] }, ['e-0004', 'e-0001']],
        ['empty ids', { ids: [] }, []],
        ['before (exclusive)', { before: at(3) }, ['e-0002', 'e-0001']],
        ['after (exclusive)', { after: at(2) }, ['e-0004', 'e-0003']],
        ['before + after', { after: at(1), before: at(4) }, ['e-0003', 'e-0002']],
        ['type + tag', { type: 'query', tag: 'user:7' }, ['e-0003']],
        ['type + batchId', { type: 'query', batchId: 'b1' }, ['e-0002']],
        ['no match', { type: 'mail' }, []],
      ];
      for (const [label, query, expected] of cases) {
        it(`filters by ${label}`, async () => {
          await seed(fixture());
          expect(ids(await all(query))).toEqual(expected);
        });
      }

      it('pages an ids query by cursor without losing or repeating any', async () => {
        await seed(fixture());
        expect(ids(await all({ ids: ['e-0001', 'e-0002', 'e-0003', 'e-0004'], limit: 1 }))).toEqual(
          ['e-0004', 'e-0003', 'e-0002', 'e-0001'],
        );
      });

      it('composes filters with the cursor', async () => {
        await seed([
          ...fixture(),
          makeEntry({ id: 'e-0005', type: 'query', tags: ['slow'], createdAt: at(5) }),
        ]);
        const first = await provider.get({ type: 'query', limit: 2 });
        expect(ids(first.data)).toEqual(['e-0005', 'e-0003']);
        const second = await provider.get({
          type: 'query',
          limit: 2,
          cursor: first.nextCursor as string,
        });
        expect(ids(second.data)).toEqual(['e-0002']);
        expect(second.nextCursor).toBeNull();
      });

      it('nulls content under omitContent and keeps every other field', async () => {
        const entries = fixture();
        await seed(entries);
        const page = await provider.get({ omitContent: true });
        expect(page.data).toHaveLength(4);
        for (const entry of page.data) {
          expect(entry.content).toBeNull();
          const original = entries.find((candidate) => candidate.id === entry.id);
          expect({ ...entry, content: original?.content }).toEqual(original);
        }
      });

      it('applies search before omitContent nulls the content', async () => {
        await seed(fixture());
        const page = await provider.get({ search: 'orders', omitContent: true });
        expect(ids(page.data)).toEqual(['e-0003']);
        expect(page.data[0]?.content).toBeNull();
      });
    });

    describe('batch', () => {
      it('returns only the batch, ordered by sequence', async () => {
        await seed([
          makeEntry({ id: 'e-0001', batchId: 'b1', sequence: 2, createdAt: at(1) }),
          makeEntry({ id: 'e-0002', batchId: 'b1', sequence: 0, createdAt: at(2) }),
          makeEntry({ id: 'e-0003', batchId: 'b2', sequence: 1, createdAt: at(3) }),
          makeEntry({ id: 'e-0004', batchId: 'b1', sequence: 1, createdAt: at(4) }),
        ]);
        expect(ids(await provider.batch('b1'))).toEqual(['e-0002', 'e-0004', 'e-0001']);
        expect(ids(await provider.batch('b2'))).toEqual(['e-0003']);
      });

      it('returns an empty list for an unknown batch', async () => {
        await seed([makeEntry({ id: 'e-0001', createdAt: at(1) })]);
        expect(await provider.batch('missing')).toEqual([]);
      });
    });

    describe('tags', () => {
      const tagged = (): Entry[] => [
        makeEntry({ id: 'e-0001', tags: ['user:1', 'slow'], createdAt: at(1) }),
        makeEntry({ id: 'e-0002', tags: ['user:2', 'slow'], createdAt: at(2) }),
        makeEntry({ id: 'e-0003', tags: ['user:1', 'Failed'], createdAt: at(3) }),
        makeEntry({ id: 'e-0004', tags: ['slow', 'Failed'], createdAt: at(4) }),
        // Newest, so a provider returning first-seen order fails the ordering assertion.
        makeEntry({ id: 'e-0005', tags: ['aaa'], createdAt: at(5) }),
        makeEntry({ id: 'e-0006', tags: [], createdAt: at(6) }),
      ];

      it('counts every tag, most used first, ties alphabetical', async () => {
        await seed(tagged());
        expect(await provider.tags()).toEqual([
          { tag: 'slow', count: 3 },
          { tag: 'Failed', count: 2 },
          { tag: 'user:1', count: 2 },
          { tag: 'aaa', count: 1 },
          { tag: 'user:2', count: 1 },
        ]);
      });

      it('anchors prefix at the start of the tag', async () => {
        await seed(tagged());
        expect(await provider.tags('user:')).toEqual([
          { tag: 'user:1', count: 2 },
          { tag: 'user:2', count: 1 },
        ]);
        expect(await provider.tags('ser')).toEqual([]);
      });

      it('matches search anywhere in the tag, case-insensitively', async () => {
        await seed(tagged());
        expect(await provider.tags(undefined, { search: 'AIL' })).toEqual([
          { tag: 'Failed', count: 2 },
        ]);
        expect(await provider.tags('user:', { search: '2' })).toEqual([
          { tag: 'user:2', count: 1 },
        ]);
      });

      it('pages with limit and offset over the ordered list', async () => {
        await seed(tagged());
        // A provider may ignore the bound (the controller re-applies it), but whatever it
        // returns must page to the same window.
        const window = async (limit: number, offset: number): Promise<TagCount[]> => {
          const rows = await provider.tags(undefined, { limit, offset });
          return rows.length > limit ? rows.slice(offset, offset + limit) : rows;
        };
        expect(await window(2, 0)).toEqual([
          { tag: 'slow', count: 3 },
          { tag: 'Failed', count: 2 },
        ]);
        expect(await window(2, 2)).toEqual([
          { tag: 'user:1', count: 2 },
          { tag: 'aaa', count: 1 },
        ]);
        expect(await window(2, 4)).toEqual([{ tag: 'user:2', count: 1 }]);
        expect(await window(2, 6)).toEqual([]);
      });
    });

    describe('update', () => {
      it('patches the given fields and leaves the rest', async () => {
        const original = makeEntry({
          id: 'e-0001',
          content: { status: null },
          tags: ['pending'],
          createdAt: at(1),
        });
        await provider.store([original]);
        await provider.update('e-0001', {
          content: { status: 200 },
          durationMs: 42,
          tags: ['status:200'],
        });
        const found = await provider.find('e-0001');
        expect(found?.content).toEqual({ status: 200 });
        expect(found?.durationMs).toBe(42);
        expect(found?.tags).toEqual(['status:200']);
        expect(found?.batchId).toBe(original.batchId);
        expect(found?.createdAt.getTime()).toBe(original.createdAt.getTime());
      });

      it('never changes the id', async () => {
        await provider.store([makeEntry({ id: 'e-0001', createdAt: at(1) })]);
        await provider.update('e-0001', { id: 'e-9999', durationMs: 1 });
        expect((await provider.find('e-0001'))?.durationMs).toBe(1);
        expect(await provider.find('e-9999')).toBeNull();
      });

      it('is a no-op for an unknown id', async () => {
        await provider.store([makeEntry({ id: 'e-0001', createdAt: at(1) })]);
        await provider.update('missing', { durationMs: 1 });
        expect(ids(await all())).toEqual(['e-0001']);
      });

      it('is reflected by get() and keeps a single copy of the entry', async () => {
        await provider.store([
          makeEntry({ id: 'e-0001', createdAt: at(1) }),
          makeEntry({ id: 'e-0002', createdAt: at(2) }),
        ]);
        await provider.update('e-0001', { durationMs: 7 });
        await provider.update('e-0001', { durationMs: 8 });
        const entries = await all();
        expect(ids(entries)).toEqual(['e-0002', 'e-0001']);
        expect(entries[1]?.durationMs).toBe(8);
      });
    });

    describe('prune', () => {
      const aged = (): Entry[] => [
        makeEntry({ id: 'e-0001', type: 'query', createdAt: at(1) }),
        makeEntry({ id: 'e-0002', type: 'request', createdAt: at(2) }),
        makeEntry({ id: 'e-0003', type: 'query', createdAt: at(3) }),
        makeEntry({ id: 'e-0004', type: 'exception', createdAt: at(4) }),
        makeEntry({ id: 'e-0005', type: 'query', createdAt: at(5) }),
      ];

      if (ttl) {
        it('prune is a no-op reporting zero', async () => {
          await provider.store(aged());
          expect(await provider.prune(at(10))).toBe(0);
          expect(await provider.prune(at(10), 1)).toBe(0);
          expect(await all()).toHaveLength(5);
        });

        it('pruneScoped and pruneScopedBatch, when present, are no-ops reporting zero', async () => {
          await provider.store(aged());
          if (provider.pruneScoped) {
            expect(await provider.pruneScoped({ before: at(10), type: 'query' })).toBe(0);
          }
          if (provider.pruneScopedBatch) {
            expect(await provider.pruneScopedBatch({ before: at(10), limit: 10 })).toEqual({
              deleted: 0,
              hasMore: false,
            });
          }
          expect(await all()).toHaveLength(5);
        });
        return;
      }

      it('deletes entries strictly older than the cutoff and reports the count', async () => {
        await provider.store(aged());
        expect(await provider.prune(at(3))).toBe(2);
        expect(ids(await all())).toEqual(['e-0005', 'e-0004', 'e-0003']);
      });

      it('keepLast spares the newest N of the doomed entries', async () => {
        await provider.store(aged());
        expect(await provider.prune(at(4), 1)).toBe(2);
        expect(ids(await all())).toEqual(['e-0005', 'e-0004', 'e-0003']);
      });

      it('deletes nothing when nothing is older than the cutoff', async () => {
        await provider.store(aged());
        expect(await provider.prune(at(0))).toBe(0);
        expect(await all()).toHaveLength(5);
      });

      it('pruneScoped by type', async () => {
        if (!provider.pruneScoped) return;
        await provider.store(aged());
        expect(await provider.pruneScoped({ before: at(5), type: 'query' })).toBe(2);
        expect(ids(await all())).toEqual(['e-0005', 'e-0004', 'e-0002']);
      });

      it('pruneScoped excluding types', async () => {
        if (!provider.pruneScoped) return;
        await provider.store(aged());
        expect(await provider.pruneScoped({ before: at(5), excludeTypes: ['query'] })).toBe(2);
        expect(ids(await all())).toEqual(['e-0005', 'e-0003', 'e-0001']);
      });

      it('pruneScoped with keepLast', async () => {
        if (!provider.pruneScoped) return;
        await provider.store(aged());
        expect(await provider.pruneScoped({ before: at(6), type: 'query', keepLast: 1 })).toBe(2);
        expect(ids(await all())).toEqual(['e-0005', 'e-0004', 'e-0002']);
      });

      it('pruneScoped with no selector covers every type', async () => {
        if (!provider.pruneScoped) return;
        await provider.store(aged());
        expect(await provider.pruneScoped({ before: at(3) })).toBe(2);
        expect(ids(await all())).toEqual(['e-0005', 'e-0004', 'e-0003']);
      });

      it('pruneScopedBatch deletes at most limit, oldest first, and reports hasMore', async () => {
        if (!provider.pruneScopedBatch) return;
        await provider.store(aged());
        const first = await provider.pruneScopedBatch({ before: at(5), limit: 3 });
        expect(first).toEqual({ deleted: 3, hasMore: true });
        expect(ids(await all())).toEqual(['e-0005', 'e-0004']);
        const second = await provider.pruneScopedBatch({ before: at(5), limit: 3 });
        expect(second.deleted).toBe(1);
        expect(second.hasMore).toBe(false);
        expect(ids(await all())).toEqual(['e-0005']);
      });

      it('pruneScopedBatch honours type and excludeTypes', async () => {
        if (!provider.pruneScopedBatch) return;
        await provider.store(aged());
        expect(
          await provider.pruneScopedBatch({ before: at(6), type: 'query', limit: 10 }),
        ).toEqual({ deleted: 3, hasMore: false });
        expect(ids(await all())).toEqual(['e-0004', 'e-0002']);
        const excluded = await provider.pruneScopedBatch({
          before: at(6),
          excludeTypes: ['exception'],
          limit: 10,
        });
        expect(excluded.deleted).toBe(1);
        expect(ids(await all())).toEqual(['e-0004']);
      });

      it('pruneScopedBatch reports an empty scope as drained', async () => {
        if (!provider.pruneScopedBatch) return;
        await provider.store(aged());
        expect(await provider.pruneScopedBatch({ before: at(0), limit: 10 })).toEqual({
          deleted: 0,
          hasMore: false,
        });
      });
    });

    describe('leases', () => {
      const capable = (): boolean =>
        typeof provider.tryAcquireLease === 'function' &&
        typeof provider.releaseLease === 'function';

      it('declares tryAcquireLease and releaseLease together or not at all', () => {
        expect(typeof provider.tryAcquireLease).toBe(typeof provider.releaseLease);
      });

      it('grants a free lease and refuses another owner while it is held', async () => {
        if (!capable()) return;
        const now = Date.now();
        expect(await provider.tryAcquireLease?.('k', 'a', 60_000, now)).toBe(true);
        expect(await provider.tryAcquireLease?.('k', 'b', 60_000, now + 1)).toBe(false);
        expect(await provider.tryAcquireLease?.('other', 'b', 60_000, now + 1)).toBe(true);
      });

      it('is re-entrant for the same owner', async () => {
        if (!capable()) return;
        const now = Date.now();
        expect(await provider.tryAcquireLease?.('k', 'a', 60_000, now)).toBe(true);
        expect(await provider.tryAcquireLease?.('k', 'a', 60_000, now + 1)).toBe(true);
      });

      it('grants an expired lease to a new owner', async () => {
        if (!capable()) return;
        expect(await provider.tryAcquireLease?.('k', 'a', 150, Date.now())).toBe(true);
        await sleep(300);
        expect(await provider.tryAcquireLease?.('k', 'b', 60_000, Date.now())).toBe(true);
        expect(await provider.tryAcquireLease?.('k', 'a', 60_000, Date.now())).toBe(false);
      });

      it('releases only for the owner, idempotently', async () => {
        if (!capable()) return;
        const now = Date.now();
        await provider.tryAcquireLease?.('k', 'a', 60_000, now);
        await provider.releaseLease?.('k', 'b');
        expect(await provider.tryAcquireLease?.('k', 'b', 60_000, now + 1)).toBe(false);
        await provider.releaseLease?.('k', 'a');
        await provider.releaseLease?.('k', 'a');
        expect(await provider.tryAcquireLease?.('k', 'b', 60_000, now + 2)).toBe(true);
      });
    });

    describe('markFamilySeen', () => {
      it('is true for a new family, false inside the window, true again after it', async () => {
        if (!provider.markFamilySeen) return;
        expect(await provider.markFamilySeen('fam', Date.now(), 150)).toBe(true);
        expect(await provider.markFamilySeen('fam', Date.now(), 150)).toBe(false);
        expect(await provider.markFamilySeen('other', Date.now(), 150)).toBe(true);
        await sleep(300);
        expect(await provider.markFamilySeen('fam', Date.now(), 150)).toBe(true);
      });
    });

    describe('rollups', () => {
      const rollups = (): RollupStore | null => (isRollupStore(provider) ? provider : null);
      const delta = (over: Partial<RollupDelta>): RollupDelta => {
        const histogram = new Array<number>(HISTOGRAM_BUCKET_COUNT).fill(0);
        histogram[2] = over.count ?? 1;
        return { metric: 'request', bucketStart: 0, count: 1, sum: 5, max: 5, histogram, ...over };
      };

      it('merges deltas additively per (metric, bucket) and keeps the max', async () => {
        const store = rollups();
        if (!store) return;
        const bucket = Math.floor(base / 60_000) * 60_000;
        await store.recordRollups([delta({ bucketStart: bucket, count: 2, sum: 10, max: 6 })]);
        await store.recordRollups([
          delta({ bucketStart: bucket, count: 3, sum: 9, max: 4 }),
          delta({ metric: 'query', bucketStart: bucket, count: 1, sum: 1, max: 1 }),
        ]);
        const [request] = await store.queryRollups(['request'], bucket, bucket);
        expect(request).toMatchObject({ metric: 'request', bucketStart: bucket });
        expect(request?.count).toBe(5);
        expect(request?.sum).toBe(19);
        expect(request?.max).toBe(6);
        expect(request?.histogram).toHaveLength(HISTOGRAM_BUCKET_COUNT);
        expect(request?.histogram[2]).toBe(5);
      });

      it('returns buckets inside the inclusive range for the asked metrics only', async () => {
        const store = rollups();
        if (!store) return;
        const bucket = Math.floor(base / 60_000) * 60_000;
        await store.recordRollups([
          delta({ bucketStart: bucket }),
          delta({ bucketStart: bucket + 60_000 }),
          delta({ bucketStart: bucket + 120_000 }),
          delta({ metric: 'query', bucketStart: bucket + 60_000 }),
        ]);
        const found = await store.queryRollups(['request'], bucket + 60_000, bucket + 120_000);
        expect(found.map((row) => [row.metric, row.bucketStart]).sort()).toEqual(
          [
            ['request', bucket + 60_000],
            ['request', bucket + 120_000],
          ].sort(),
        );
      });
    });

    describe('clear', () => {
      it('removes every entry', async () => {
        await provider.store(series(3, (i) => ({ createdAt: at(i) })));
        await provider.clear();
        expect((await provider.get({})).data).toEqual([]);
        expect(await provider.tags()).toEqual([]);
      });
    });
  });
}

/** A complete entry with neutral defaults; `over` wins. */
export function makeEntry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'e-0000',
    batchId: 'batch',
    type: 'request',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'instance',
    traceId: null,
    spanId: null,
    createdAt: new Date(0),
    ...over,
  };
}

/** `count` entries with ids `e-0000`… — fixed-width, so string order matches numeric order. */
function series(count: number, over: (index: number) => Partial<Entry>): Entry[] {
  return Array.from({ length: count }, (_, index) =>
    makeEntry({ id: `e-${String(index).padStart(4, '0')}`, ...over(index) }),
  );
}

function sortNewestFirst(entries: Entry[]): Entry[] {
  return [...entries].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
