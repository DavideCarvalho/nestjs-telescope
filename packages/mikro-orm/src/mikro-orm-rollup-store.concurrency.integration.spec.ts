// Integration: two MikroOrmStorageProvider instances (two pods) writing rollups
// for the SAME buckets into one SQLite file at once.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RollupDelta, emptyHistogram, incrementHistogram } from '@dudousxd/nestjs-telescope';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmStorageProvider } from './mikro-orm-storage.provider.js';

function histogramAt(durationMs: number): number[] {
  const histogram = emptyHistogram();
  incrementHistogram(histogram, durationMs);
  return histogram;
}

function deltasFor(round: number): RollupDelta[] {
  return ['request', 'query'].flatMap((metric) =>
    [0, 60_000, 120_000].map((bucketStart) => ({
      metric,
      bucketStart,
      count: 1,
      sum: round,
      max: round,
      histogram: histogramAt(round % 2 === 0 ? 5 : 5_000),
    })),
  );
}

describe('MikroOrmStorageProvider rollups under concurrent writers (sqlite file)', () => {
  const dbFile = join(tmpdir(), `telescope-rollup-concurrent-${process.pid}.sqlite`);
  const providers: MikroOrmStorageProvider[] = [];

  afterEach(async () => {
    for (const provider of providers.splice(0)) await provider.close();
    rmSync(dbFile, { force: true });
  });

  it('loses no increment when two writers merge into the same buckets at once', async () => {
    rmSync(dbFile, { force: true });
    const first = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
    providers.push(first);
    await first.init();
    const second = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
    providers.push(second);
    await second.init();

    const rounds = 40;
    const writes: Promise<void>[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const writer = round % 2 === 0 ? first : second;
      writes.push(writer.recordRollups(deltasFor(round)));
    }
    const outcomes = await Promise.allSettled(writes);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([]);

    const rows = await first.queryRollups(['request', 'query'], 0, 120_000);
    expect(rows).toHaveLength(6);
    const expectedHistogram = emptyHistogram();
    for (let round = 0; round < rounds; round += 1) {
      incrementHistogram(expectedHistogram, round % 2 === 0 ? 5 : 5_000);
    }
    for (const row of rows) {
      expect(row.count).toBe(rounds);
      expect(row.sum).toBe((rounds * (rounds - 1)) / 2);
      expect(row.max).toBe(rounds - 1);
      expect(row.histogram).toEqual(expectedHistogram);
    }
  });
});
