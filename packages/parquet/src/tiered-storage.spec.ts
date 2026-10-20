import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entry } from '@dudousxd/nestjs-telescope';
import {
  InMemoryStorageProvider,
  TelescopePruner,
  isLeaseCapableStorage,
  isRollupStore,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { makeEntry } from '@dudousxd/nestjs-telescope-testing/conformance';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveToCold } from '../test/tiers.js';
import { type ParquetColdStore, parquetColdStore } from './parquet-cold-store.js';
import { type TieredStorageProvider, tieredStorage } from './tiered-storage.js';

const base = Math.floor((Date.now() - 3 * 60 * 60 * 1000) / 1000) * 1000;
const at = (seconds: number): Date => new Date(base + seconds * 1000);
const series = (count: number, start = 0): Entry[] =>
  Array.from({ length: count }, (_, index) =>
    makeEntry({
      id: `e-${String(start + index).padStart(4, '0')}`,
      createdAt: at(start + index),
      batchId: `b-${Math.floor((start + index) / 5)}`,
      sequence: (start + index) % 5,
    }),
  );
const ids = (entries: Entry[]): string[] => entries.map((entry) => entry.id);

async function pageAll(tiered: TieredStorageProvider, limit: number): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await tiered.get({ limit, ...(cursor ? { cursor } : {}) });
    out.push(...ids(page.data));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return out;
}

describe('tieredStorage', () => {
  let dir: string;
  let hot: InMemoryStorageProvider;
  let cold: ParquetColdStore;
  let tiered: TieredStorageProvider;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'telescope-tiered-'));
    hot = new InMemoryStorageProvider();
    cold = parquetColdStore({ location: { dir }, compaction: false });
    tiered = tieredStorage({ hot, cold });
    await tiered.init();
  });

  afterEach(async () => {
    await tiered.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('the tier boundary', () => {
    it('returns an entry once while it is in both tiers (archived, not yet deleted)', async () => {
      const entries = series(10);
      await tiered.store(entries);
      await cold.write(entries.slice(0, 6));

      expect(await pageAll(tiered, 3)).toEqual(ids(entries).reverse());
      expect((await tiered.find('e-0002'))?.id).toBe('e-0002');
      expect(ids(await tiered.batch('b-0'))).toEqual([
        'e-0000',
        'e-0001',
        'e-0002',
        'e-0003',
        'e-0004',
      ]);
      expect(ids((await tiered.get({ ids: ['e-0001', 'e-0002'] })).data)).toEqual([
        'e-0002',
        'e-0001',
      ]);
    });

    it('prefers the hot copy of an entry that is in both tiers', async () => {
      const [entry] = series(1);
      await tiered.store([entry!]);
      await cold.write([entry!]);
      await tiered.update('e-0000', { durationMs: 99 });
      expect((await tiered.get({})).data[0]?.durationMs).toBe(99);
    });

    it('pages without gaps or repeats while entries move to the cold tier between pages', async () => {
      const entries = series(40);
      await tiered.store(entries);
      const seen: string[] = [];

      let page = await tiered.get({ limit: 7 });
      seen.push(...ids(page.data));
      // Everything older than the newest 10 moves cold, through the page boundary.
      await moveToCold(tiered, at(30));
      while (page.nextCursor !== null) {
        page = await tiered.get({ limit: 7, cursor: page.nextCursor });
        seen.push(...ids(page.data));
        // Archive written but not yet deleted from hot, then deleted: both states are mid-paging.
        if (seen.length === 14)
          await cold.write((await hot.get({ before: at(20), limit: 100 })).data);
        if (seen.length === 21) await hot.prune(at(20));
      }

      expect(seen).toEqual(ids(entries).reverse());
    });

    it('reads mostly from cold once the hot tier is minutes deep', async () => {
      await tiered.store(series(100));
      await moveToCold(tiered, at(95));
      expect((await hot.get({})).data).toHaveLength(5);
      expect(await pageAll(tiered, 30)).toEqual(ids(series(100)).reverse());
      expect(ids((await tiered.get({ batchId: 'b-3' })).data)).toEqual([
        'e-0019',
        'e-0018',
        'e-0017',
        'e-0016',
        'e-0015',
      ]);
    });
  });

  describe('with the pruner', () => {
    it('archives to the cold tier, deletes from hot, and keeps every entry readable', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const entries = series(30).map((entry) => ({ ...entry, type: 'query' }));
      await tiered.store(entries);
      await tiered.store([makeEntry({ id: 'fresh', type: 'query', createdAt: new Date() })]);

      const config = resolveConfig({
        enabled: true,
        prune: { after: '5m', intervalMs: 1000 },
        archive: cold.archive({ types: ['query'] }),
      });
      await new TelescopePruner(config, tiered).pruneNow();

      expect(ids((await hot.get({})).data)).toEqual(['fresh']);
      expect((await cold.query({})).length).toBe(30);
      const all = await pageAll(tiered, 8);
      expect(all).toEqual(['fresh', ...ids(entries).reverse()]);
    });

    it('sizes archive() for Parquet', () => {
      const archive = cold.archive({ types: ['query'] });
      expect(archive.batchSize).toBe(5000);
      expect(archive.maxBatchesPerCycle).toBe(20);
      expect(
        cold.archive({ types: ['query'], batchSize: 10, maxBatchesPerCycle: 2 }),
      ).toMatchObject({ batchSize: 10, maxBatchesPerCycle: 2 });
    });
  });

  describe('capabilities', () => {
    it("mirrors the hot store's optional SPI members", () => {
      expect(isLeaseCapableStorage(tiered)).toBe(true);
      expect(isRollupStore(tiered)).toBe(true);
      expect(typeof tiered.pruneScopedBatch).toBe('function');
      expect(typeof tiered.markFamilySeen).toBe('function');

      const minimal = tieredStorage({
        hot: {
          store: async () => {},
          update: async () => {},
          find: async () => null,
          get: async () => ({ data: [], nextCursor: null }),
          batch: async () => [],
          tags: async () => [],
          prune: async () => 0,
          clear: async () => {},
        },
        cold,
      });
      expect(isLeaseCapableStorage(minimal)).toBe(false);
      expect(isRollupStore(minimal)).toBe(false);
      expect(minimal.pruneScoped).toBeUndefined();
      expect(minimal.pruneScopedBatch).toBeUndefined();
      expect(minimal.markFamilySeen).toBeUndefined();
    });
  });

  describe('when the cold tier cannot be read', () => {
    it('serves hot entries, flags the page partial, and warns once', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const broken = parquetColdStore({
        location: {
          s3: {
            bucket: 'b',
            client: { send: () => Promise.reject(new Error('s3 is down')) },
          },
        },
        compaction: false,
      });
      const degraded = tieredStorage({ hot, cold: broken });
      await degraded.store(series(3));

      const page = await degraded.get({});
      expect(ids(page.data)).toEqual(['e-0002', 'e-0001', 'e-0000']);
      expect(page.partial).toBe(true);
      expect((await degraded.find('e-0001'))?.id).toBe('e-0001');
      expect(await degraded.find('missing')).toBeNull();
      expect(await degraded.tags()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('s3 is down');
    });

    it('does not flag a page whose cold read succeeded', async () => {
      await tiered.store(series(3));
      expect((await tiered.get({})).partial).toBeUndefined();
    });
  });

  describe('maintenance under the prune lease', () => {
    it('runs cold compaction from the prune path at most once per interval', async () => {
      const compacting = parquetColdStore({ location: { dir }, compaction: { every: '15m' } });
      const spy = vi.spyOn(compacting, 'compact').mockResolvedValue(0);
      const withCompaction = tieredStorage({ hot, cold: compacting });
      await withCompaction.pruneScopedBatch?.({ before: at(0), limit: 10 });
      await withCompaction.pruneScopedBatch?.({ before: at(0), limit: 10 });
      await withCompaction.prune(at(0));
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
