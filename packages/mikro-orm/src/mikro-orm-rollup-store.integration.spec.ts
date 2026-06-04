// packages/mikro-orm/src/mikro-orm-rollup-store.integration.spec.ts
//
// Integration: the MikroOrmStorageProvider's RollupStore SPI against a real
// MikroORM SqliteDriver. Mirrors the entry integration spec's bootstrap
// (`:memory:` for round-trips, a temp FILE db for the self-heal guard) and the
// additive semantics of the core SqliteStorageProvider's `telescope_rollups`.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyHistogram, incrementHistogram, isRollupStore } from '@dudousxd/nestjs-telescope';
import type { RollupDelta } from '@dudousxd/nestjs-telescope';
import { MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MikroOrmStorageProvider } from './mikro-orm-storage.provider.js';

/** A histogram with a single sample in the cell for `durationMs`. */
function histogramAt(durationMs: number): number[] {
  const histogram = emptyHistogram();
  incrementHistogram(histogram, durationMs);
  return histogram;
}

function delta(overrides: Partial<RollupDelta> = {}): RollupDelta {
  return {
    metric: 'request',
    bucketStart: 60_000,
    count: 1,
    sum: 10,
    max: 10,
    histogram: histogramAt(10),
    ...overrides,
  };
}

describe('MikroOrmStorageProvider RollupStore (sqlite)', () => {
  let provider: MikroOrmStorageProvider;

  beforeEach(() => {
    provider = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: ':memory:' });
  });

  afterEach(async () => {
    await provider.close();
  });

  it('is duck-typed as a RollupStore (both SPI methods present)', () => {
    expect(isRollupStore(provider)).toBe(true);
  });

  it('record then query round-trips a single bucket incl. its histogram', async () => {
    await provider.init();
    await provider.recordRollups([
      delta({ count: 3, sum: 30, max: 20, histogram: histogramAt(20) }),
    ]);

    const rows = await provider.queryRollups(['request'], 0, 120_000);
    expect(rows).toEqual([
      {
        metric: 'request',
        bucketStart: 60_000,
        count: 3,
        sum: 30,
        max: 20,
        histogram: histogramAt(20),
      },
    ]);
  });

  it('accumulates count+sum, keeps the running max, and merges histograms (additive contract)', async () => {
    await provider.init();
    // Same (metric, bucketStart) recorded three times: count/sum add up, max is
    // the running maximum (40 wins over 10 and 25), histograms merge element-wise.
    await provider.recordRollups([
      delta({ count: 1, sum: 10, max: 10, histogram: histogramAt(10) }),
    ]);
    await provider.recordRollups([
      delta({ count: 2, sum: 50, max: 40, histogram: histogramAt(40) }),
    ]);
    await provider.recordRollups([
      delta({ count: 4, sum: 8, max: 25, histogram: histogramAt(25) }),
    ]);

    const expectedHistogram = emptyHistogram();
    incrementHistogram(expectedHistogram, 10);
    incrementHistogram(expectedHistogram, 40);
    incrementHistogram(expectedHistogram, 25);

    const rows = await provider.queryRollups(['request'], 60_000, 60_000);
    expect(rows).toEqual([
      {
        metric: 'request',
        bucketStart: 60_000,
        count: 7,
        sum: 68,
        max: 40,
        histogram: expectedHistogram,
      },
    ]);
  });

  it('merges histograms within a single multi-delta batch hitting the same bucket', async () => {
    await provider.init();
    await provider.recordRollups([
      delta({ count: 1, sum: 10, max: 10, histogram: histogramAt(10) }),
      delta({ count: 2, sum: 20, max: 30, histogram: histogramAt(30) }),
    ]);

    const expectedHistogram = emptyHistogram();
    incrementHistogram(expectedHistogram, 10);
    incrementHistogram(expectedHistogram, 30);

    const rows = await provider.queryRollups(['request'], 60_000, 60_000);
    expect(rows).toEqual([
      {
        metric: 'request',
        bucketStart: 60_000,
        count: 3,
        sum: 30,
        max: 30,
        histogram: expectedHistogram,
      },
    ]);
  });

  it('filters by metric set and bucket range; empty metrics ⇒ []', async () => {
    await provider.init();
    await provider.recordRollups([
      delta({ metric: 'request', bucketStart: 60_000 }),
      delta({ metric: 'request', bucketStart: 120_000 }),
      delta({ metric: 'request', bucketStart: 180_000 }),
      delta({ metric: 'query', bucketStart: 120_000 }),
      delta({ metric: 'cache', bucketStart: 120_000 }),
    ]);

    // Metric set excludes 'cache'; range [60_000, 120_000] excludes bucket 180_000.
    const rows = await provider.queryRollups(['request', 'query'], 60_000, 120_000);
    const keys = rows.map((r) => `${r.metric}@${r.bucketStart}`).sort();
    expect(keys).toEqual(['query@120000', 'request@120000', 'request@60000']);

    // Range boundaries are inclusive (between fromBucket and toBucket).
    const boundary = await provider.queryRollups(['request'], 60_000, 60_000);
    expect(boundary.map((r) => r.bucketStart)).toEqual([60_000]);

    expect(await provider.queryRollups([], 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('no-ops on empty deltas', async () => {
    await provider.init();
    await provider.recordRollups([]);
    expect(await provider.queryRollups(['request'], 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('clear() empties the rollups table too', async () => {
    await provider.init();
    await provider.recordRollups([delta({ count: 5, sum: 5, max: 5 })]);
    expect(await provider.queryRollups(['request'], 0, 120_000)).toHaveLength(1);

    await provider.clear();
    expect(await provider.queryRollups(['request'], 0, 120_000)).toEqual([]);
  });
});

describe('MikroOrmStorageProvider rollup self-heal (file sqlite)', () => {
  it('init() creates telescope_rollups from scratch with no migration', async () => {
    const dbFile = join(tmpdir(), `telescope-rollup-fresh-${process.pid}.sqlite`);
    rmSync(dbFile, { force: true });
    let provider: MikroOrmStorageProvider | null = null;

    try {
      // A bare db with NO telescope_rollups table. Only init() runs — if record +
      // query succeed, schema.update({ safe }) must have created the table.
      const seedOrm = await MikroORM.init({
        driver: SqliteDriver,
        dbName: dbFile,
        entities: [],
        allowGlobalContext: true,
        discovery: { warnWhenNoEntities: false },
      });
      await seedOrm.close(true);

      provider = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
      await provider.init();

      await provider.recordRollups([
        delta({ count: 2, sum: 22, max: 22, histogram: histogramAt(22) }),
      ]);
      const rows = await provider.queryRollups(['request'], 0, 120_000);
      expect(rows).toEqual([
        {
          metric: 'request',
          bucketStart: 60_000,
          count: 2,
          sum: 22,
          max: 22,
          histogram: histogramAt(22),
        },
      ]);
    } finally {
      await provider?.close();
      rmSync(dbFile, { force: true });
    }
  });

  it('leaves a pre-existing telescope_rollups row intact (additive, no drop)', async () => {
    const dbFile = join(tmpdir(), `telescope-rollup-additive-${process.pid}.sqlite`);
    rmSync(dbFile, { force: true });
    let provider: MikroOrmStorageProvider | null = null;

    try {
      // Pre-create telescope_rollups and seed a row on a bare connection (no
      // TelescopeRollup metadata), then prove init()'s additive schema.update
      // does not drop it and the provider keeps accumulating onto it.
      const seedOrm = await MikroORM.init({
        driver: SqliteDriver,
        dbName: dbFile,
        entities: [],
        allowGlobalContext: true,
        discovery: { warnWhenNoEntities: false },
      });
      const conn = seedOrm.em.getConnection();
      await conn.execute(
        'create table `telescope_rollups` (`metric` text not null, `bucket_start` integer not null, `count` integer not null, `sum` integer not null, `max` integer not null, primary key (`metric`, `bucket_start`))',
      );
      await conn.execute(
        "insert into `telescope_rollups` (`metric`, `bucket_start`, `count`, `sum`, `max`) values ('request', 60000, 3, 30, 15)",
      );
      await seedOrm.close(true);

      provider = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
      await provider.init();

      // Pre-existing row (created WITHOUT a histogram column) survived the
      // additive update and reads back with an all-zeros histogram — never NaN.
      const pre = await provider.queryRollups(['request'], 60_000, 60_000);
      expect(pre).toEqual([
        {
          metric: 'request',
          bucketStart: 60_000,
          count: 3,
          sum: 30,
          max: 15,
          histogram: emptyHistogram(),
        },
      ]);

      // And further records accumulate onto it (running max 25 > 15), merging a
      // real histogram onto the legacy zero base.
      await provider.recordRollups([
        delta({ count: 1, sum: 5, max: 25, histogram: histogramAt(25) }),
      ]);
      const post = await provider.queryRollups(['request'], 60_000, 60_000);
      expect(post).toEqual([
        {
          metric: 'request',
          bucketStart: 60_000,
          count: 4,
          sum: 35,
          max: 25,
          histogram: histogramAt(25),
        },
      ]);
    } finally {
      await provider?.close();
      rmSync(dbFile, { force: true });
    }
  });
});
