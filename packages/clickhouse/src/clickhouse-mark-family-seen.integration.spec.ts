import { Logger } from '@nestjs/common';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  CLICKHOUSE_PASSWORD,
  CLICKHOUSE_USER,
  startClickHouse,
} from '../test/clickhouse-container.js';
import { ClickHouseStorageProvider } from './clickhouse-storage-provider.js';

const withKeeper = await startClickHouse();
const withoutKeeper = await startClickHouse({ keeper: false });
const credentials = { username: CLICKHOUSE_USER, password: CLICKHOUSE_PASSWORD };

afterAll(async () => {
  await withKeeper?.stop();
  await withoutKeeper?.stop();
});

let tables = 0;
const uniqueSuffix = (): string => {
  tables += 1;
  return `${Date.now()}_${tables}`;
};

/** A provider on `baseUrl`; providers given the same `suffix` share tables, like replicas. */
function provider(baseUrl: string, suffix = uniqueSuffix()): ClickHouseStorageProvider {
  return new ClickHouseStorageProvider({
    url: baseUrl,
    database: 'telescope',
    ...(baseUrl === process.env.CLICKHOUSE_URL ? {} : credentials),
    table: `seen_entries_${suffix}`,
    rollupTable: `seen_rollups_${suffix}`,
    seenFamiliesTable: `seen_families_${suffix}`,
  });
}

describe.skipIf(withKeeper === null)('ClickHouse markFamilySeen with Keeper', () => {
  it('is available once init() has created the KeeperMap table', async () => {
    const store = provider(withKeeper!.baseUrl);
    expect(store.markFamilySeen).toBeUndefined();
    await store.init();
    expect(typeof store.markFamilySeen).toBe('function');
    await store.close();
  });

  // 144 calls through Keeper; slow when the machine is busy, so a generous timeout.
  it(
    'answers true exactly once per window across many concurrent callers',
    { timeout: 60_000 },
    async () => {
      // Separate providers, each with its own HTTP client, sharing one table: replicas.
      const suffix = uniqueSuffix();
      const shared = Array.from({ length: 8 }, () => provider(withKeeper!.baseUrl, suffix));
      await Promise.all(shared.map((store) => store.init()));

      const round = async (nowMs: number): Promise<boolean[]> =>
        Promise.all(
          shared.flatMap((store) =>
            Array.from({ length: 6 }, () => store.markFamilySeen!('fam', nowMs, 1000)),
          ),
        );

      const now = Date.now();
      const opening = await round(now);
      expect(opening.filter(Boolean)).toHaveLength(1);
      expect(opening).toHaveLength(48);

      const inside = await round(now + 500);
      expect(inside.filter(Boolean)).toHaveLength(0);

      // The window slides with each sighting: 1,600ms after the opening is only 1,100ms after the
      // last sighting at +500, so the next window starts there.
      const next = await round(now + 1600);
      expect(next.filter(Boolean)).toHaveLength(1);

      await Promise.all(shared.map((store) => store.close()));
    },
  );

  it('slides the window on every sighting, like the other providers', async () => {
    const store = provider(withKeeper!.baseUrl);
    await store.init();
    expect(await store.markFamilySeen!('f', 1_000, 100)).toBe(true);
    expect(await store.markFamilySeen!('f', 1_090, 100)).toBe(false);
    expect(await store.markFamilySeen!('f', 1_150, 100)).toBe(false);
    expect(await store.markFamilySeen!('f', 1_250, 100)).toBe(true);
    expect(await store.markFamilySeen!('g', 1_250, 100)).toBe(true);
    await store.clear();
    expect(await store.markFamilySeen!('f', 1_260, 100)).toBe(true);
    await store.close();
  });
});

describe.skipIf(withoutKeeper === null)('ClickHouse markFamilySeen without Keeper', () => {
  it('omits the method and warns once with how to enable it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const a = provider(withoutKeeper!.baseUrl);
    const b = provider(withoutKeeper!.baseUrl);
    await a.init();
    await b.init();
    expect(a.markFamilySeen).toBeUndefined();
    expect(b.markFamilySeen).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/keeper_map_path_prefix/);
    // Everything else works.
    await a.store([]);
    expect((await a.get({})).data).toEqual([]);
    warn.mockRestore();
    await a.close();
    await b.close();
  });
});
