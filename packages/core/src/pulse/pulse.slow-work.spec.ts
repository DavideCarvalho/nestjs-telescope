// packages/core/src/pulse/pulse.slow-work.spec.ts
//
// "Slowest jobs": queue jobs and durable workflow steps ranked together by p95, from the scan and
// from the store's aggregation alike.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { SqliteStorageProvider } from '../storage/sqlite-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { durableStepName, rankSlowWork, slowWorkKind } from './pulse-summary.js';
import { PulseService } from './pulse.service.js';

let seq = 0;
function entry(type: string, extra: Partial<Entry>): Entry {
  seq += 1;
  return {
    id: `e-${String(seq).padStart(6, '0')}`,
    batchId: `b-${seq}`,
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'queue',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(Date.now() - 60_000),
    ...extra,
  };
}

function seed(): Entry[] {
  const rows: Entry[] = [];
  for (let t = 0; t < 12; t++) {
    // A queue job family; t = 5 failed.
    rows.push(
      entry('job', {
        familyHash: `mail:send-${t % 3}`,
        durationMs: 10 + t,
        tags: ['queue:mail', ...(t === 5 ? ['failed'] : [])],
      }),
    );
    // A durable step: completions and failures of one step share its family.
    rows.push(
      entry('durable', {
        familyHash: `durable:step:index-${t % 2}`,
        durationMs: 1_000 + t * 100,
        tags: [
          'durable',
          t % 4 === 0 ? 'step.failed' : 'step.completed',
          ...(t % 4 === 0 ? ['failed'] : []),
        ],
      }),
    );
  }
  // Not durable steps: a run event, an untimed step start, and a step from an older durable
  // (no family).
  rows.push(entry('durable', { familyHash: 'durable:run.completed', tags: ['durable'] }));
  rows.push(entry('durable', { familyHash: null, durationMs: 9_999, tags: ['step.completed'] }));
  // Another type's timed family.
  rows.push(entry('request', { familyHash: 'GET /slow', durationMs: 50_000 }));
  return rows;
}

const stores: [string, () => StorageProvider][] = [
  ['scan (in-memory)', () => new InMemoryStorageProvider()],
  ['store aggregation (sqlite)', () => new SqliteStorageProvider({ path: ':memory:' })],
];

describe('Pulse slowWork', () => {
  for (const [label, make] of stores) {
    it(`${label}: merges queue jobs and durable steps by p95, with max, count and failures`, async () => {
      const store = make();
      await store.store(seed());
      const pulse = await new PulseService(store, { topN: 10 }).getHealth(3_600_000, {
        cards: ['slowJobs'],
      });
      const rows = pulse.slowWork;
      expect(rows.slice(0, 2).map((row) => [row.source, row.name])).toEqual([
        ['durable', 'index-1'],
        ['durable', 'index-0'],
      ]);
      // index-0 ran at t = 0, 2, …, 10 (1000..2000ms); t = 0, 4, 8 failed.
      expect(rows[1]).toEqual({
        source: 'durable',
        name: 'index-0',
        count: 6,
        failures: 3,
        p50: 1_400,
        p95: 2_000,
        max: 2_000,
      });
      expect(rows[0]).toMatchObject({ count: 6, failures: 0, max: 2_100 });
      expect(rows.find((row) => row.name === 'mail:send-2')).toEqual({
        source: 'queue',
        name: 'mail:send-2',
        count: 4,
        failures: 1,
        p50: 15,
        p95: 21,
        max: 21,
      });
      // Run events, unfamilied (older) steps and other types are not background work.
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.source === 'queue' || row.name.startsWith('index-'))).toBe(
        true,
      );
      // The queue-only card is unchanged.
      expect(pulse.slowJobs.map((job) => job.route).sort()).toEqual([
        'mail:send-0',
        'mail:send-1',
        'mail:send-2',
      ]);
    });

    it(`${label}: empty when the card is not asked for`, async () => {
      const store = make();
      await store.store(seed());
      const pulse = await new PulseService(store).getHealth(3_600_000, { cards: ['slowest'] });
      expect(pulse.slowWork).toEqual([]);
    });
  }

  it('the scan and the store aggregation agree', async () => {
    const rows = seed();
    const scan = new InMemoryStorageProvider();
    const sql = new SqliteStorageProvider({ path: ':memory:' });
    await scan.store(rows);
    await sql.store(rows);
    const read = (store: StorageProvider) =>
      new PulseService(store, { topN: 10 }).getHealth(3_600_000).then((p) => p.slowWork);
    expect(await read(sql)).toEqual(await read(scan));
  });
});

describe('slow-work helpers', () => {
  it('names a durable step from its family, and nothing else', () => {
    expect(durableStepName('durable:step:charge card')).toBe('charge card');
    expect(durableStepName('durable:run.completed')).toBeNull();
    expect(slowWorkKind('durable', 'durable:step:a')).toEqual({ source: 'durable', name: 'a' });
    expect(slowWorkKind('durable', 'durable:run.failed')).toBeNull();
    expect(slowWorkKind('job', 'mail:send')).toEqual({ source: 'queue', name: 'mail:send' });
    expect(slowWorkKind('request', 'durable:step:a')).toBeNull();
  });

  it('ranks by p95, then max, then executions, and keeps the top N', () => {
    const row = (name: string, p95: number, max: number, count: number) => ({
      source: 'queue' as const,
      name,
      count,
      failures: 0,
      p50: 0,
      p95,
      max,
    });
    const ranked = rankSlowWork(
      [row('a', 10, 10, 1), row('b', 20, 20, 1), row('c', 20, 30, 1), row('d', 20, 30, 5)],
      { topN: 3 },
    );
    expect(ranked.map((r) => r.name)).toEqual(['d', 'c', 'b']);
  });
});
