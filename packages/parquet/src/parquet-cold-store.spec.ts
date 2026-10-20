import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Entry } from '@dudousxd/nestjs-telescope';
import { makeEntry } from '@dudousxd/nestjs-telescope-testing/conformance';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { v7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOUR_MS, fileKey, parseFileKey, uuidV7Time } from './layout.js';
import { type ParquetColdStore, parquetColdStore } from './parquet-cold-store.js';

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

const hourStart = Math.floor((Date.now() - 6 * HOUR_MS) / HOUR_MS) * HOUR_MS;
const entry = (index: number, over: Partial<Entry> = {}): Entry =>
  makeEntry({
    id: `e-${String(index).padStart(5, '0')}`,
    type: 'query',
    createdAt: new Date(hourStart + index * 10),
    ...over,
  });

describe('parquetColdStore', () => {
  let dir: string;
  let cold: ParquetColdStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'telescope-cold-'));
    cold = parquetColdStore({ location: { dir }, rowGroupSize: 100, instanceId: 'pod/1' });
    await cold.init();
  });

  afterEach(async () => {
    await cold.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('layout', () => {
    it('writes one file per type and hour under type=/dt=/hour=', async () => {
      await cold.write([
        entry(1),
        entry(2, { type: 'request' }),
        entry(3, { createdAt: new Date(hourStart + HOUR_MS + 5) }),
      ]);
      const day = new Date(hourStart).toISOString().slice(0, 10);
      const hour = String(new Date(hourStart).getUTCHours()).padStart(2, '0');
      const written = files(dir);
      expect(written).toHaveLength(3);
      expect(written).toContainEqual(
        expect.stringMatching(
          new RegExp(`^type=query/dt=${day}/hour=${hour}/pod_1-[0-9a-f-]{36}\\.parquet$`),
        ),
      );
      expect(written.filter((key) => key.startsWith('type=request/'))).toHaveLength(1);
    });

    it('encodes type names that are not path-safe', () => {
      const key = fileKey({ type: 'a/b c', hourStart }, 'i');
      expect(key.startsWith('type=a%2Fb%20c/')).toBe(true);
      expect(parseFileKey(key)).toEqual({ type: 'a/b c', hourStart });
    });

    it('reads the timestamp of a UUIDv7 and nothing else', () => {
      const now = Date.now();
      expect(Math.abs((uuidV7Time(v7()) ?? 0) - now)).toBeLessThan(1000);
      expect(uuidV7Time('e-0001')).toBeNull();
      expect(uuidV7Time('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBeNull();
    });
  });

  describe('files', () => {
    it('sorts rows by (createdAt, id), cuts row groups, and keeps statistics and bloom filters', async () => {
      const shuffled = Array.from({ length: 250 }, (_, index) =>
        entry(index, { traceId: `trace-${index % 7}` }),
      ).reverse();
      await cold.write(shuffled);
      const [key] = files(dir);
      const file = await asyncBufferFromFile(join(dir, key!));
      const metadata = await parquetMetadataAsync(file);
      expect(metadata.row_groups.map((group) => Number(group.num_rows))).toEqual([100, 100, 50]);
      const rows = await parquetReadObjects({ file, columns: ['id', 'created_at'] });
      expect(rows.map((row) => row.id)).toEqual(
        Array.from({ length: 250 }, (_, index) => `e-${String(index).padStart(5, '0')}`),
      );
      for (const group of metadata.row_groups) {
        const byName = new Map(
          group.columns.map((c) => [c.meta_data?.path_in_schema.join('.'), c]),
        );
        expect(byName.get('created_at')?.meta_data?.statistics?.min_value).toBeInstanceOf(Date);
        for (const bloomed of ['id', 'batch_id', 'trace_id']) {
          expect(byName.get(bloomed)?.meta_data?.bloom_filter_offset).toBeDefined();
        }
      }
    });
  });

  describe('compaction', () => {
    it('merges a closed hour into one sorted file and drops duplicate ids', async () => {
      const entries = Array.from({ length: 300 }, (_, index) => entry(index));
      await cold.write(entries.filter((_, index) => index % 3 === 0));
      await cold.write(entries.filter((_, index) => index % 3 === 1));
      await cold.write(entries.filter((_, index) => index % 3 === 2));
      await cold.write(entries.slice(0, 10)); // a re-archived batch
      expect(files(dir)).toHaveLength(4);

      expect(await cold.compact(Date.now())).toBe(1);
      const after = files(dir);
      expect(after).toHaveLength(1);
      const rows = await parquetReadObjects({
        file: await asyncBufferFromFile(join(dir, after[0]!)),
        columns: ['id'],
      });
      expect(rows.map((row) => row.id)).toEqual(entries.map((e) => e.id));
      expect((await cold.query({ limit: 500 }, 500)).map((e) => e.id)).toEqual(
        entries.map((e) => e.id).reverse(),
      );
    });

    it('leaves hours that are not closed yet, and hours already compacted', async () => {
      const recent = Date.now() - 30 * 60 * 1000;
      await cold.write([entry(1, { createdAt: new Date(recent) })]);
      await cold.write([entry(2, { createdAt: new Date(recent + 1) })]);
      await cold.write([entry(3)]);
      expect(await cold.compact(Date.now())).toBe(0);
      expect(files(dir)).toHaveLength(3);
    });

    it('splits a large hour into files near the target size', async () => {
      const big = parquetColdStore({
        location: { dir },
        rowGroupSize: 200,
        compaction: { targetFileMb: 0.15 },
      });
      // Incompressible, so file size tracks row count.
      const entries = Array.from({ length: 1200 }, (_, index) =>
        entry(index, { content: { payload: randomBytes(150).toString('hex') } }),
      );
      for (let index = 0; index < entries.length; index += 100) {
        await big.write(entries.slice(index, index + 100));
      }
      expect(files(dir)).toHaveLength(12);
      await big.compact(Date.now());
      // ~400 KB of rows at a 150 KB target.
      const after = files(dir);
      expect(after.length).toBeGreaterThanOrEqual(2);
      expect(after.length).toBeLessThanOrEqual(4);
      expect((await big.query({}, 2000)).length).toBe(1200);
    });
  });

  describe('retention', () => {
    it('deletes whole hours older than their type retention', async () => {
      const expiring = parquetColdStore({
        location: { dir },
        retention: { default: '1h', perType: { exception: '30d' } },
      });
      await expiring.write([
        entry(1),
        entry(2, { type: 'exception' }),
        entry(3, { createdAt: new Date(Date.now() - 10 * 60 * 1000) }),
      ]);
      expect(await expiring.expire(Date.now())).toBe(1);
      expect((await expiring.query({})).map((e) => e.id).sort()).toEqual(['e-00002', 'e-00003']);
    });
  });

  describe('reads', () => {
    it('finds by id and batch around a UUIDv7 timestamp and across the whole tier', async () => {
      const id = v7();
      const batchId = v7();
      await cold.write([
        makeEntry({ id, batchId, createdAt: new Date(Date.now() - 2 * HOUR_MS) }),
        makeEntry({ id: 'plain', batchId: 'plain-batch', createdAt: new Date(hourStart) }),
      ]);
      expect((await cold.find(id))?.batchId).toBe(batchId);
      expect((await cold.find('plain'))?.batchId).toBe('plain-batch');
      expect((await cold.batch(batchId)).map((e) => e.id)).toEqual([id]);
      expect(await cold.batch(v7(), { wholeTierOnMiss: false })).toEqual([]);
    });

    it('stops reading once the newest page is certain', async () => {
      for (let hour = 0; hour < 4; hour += 1) {
        await cold.write(
          Array.from({ length: 50 }, (_, index) =>
            entry(index, {
              id: `h${hour}-${String(index).padStart(3, '0')}`,
              createdAt: new Date(hourStart - hour * HOUR_MS + index),
            }),
          ),
        );
      }
      const reads = vi.spyOn(cold.location, 'read');
      const page = await cold.query({}, 10);
      const newestHour = String(new Date(hourStart).getUTCHours()).padStart(2, '0');
      expect(reads.mock.calls.every(([key]) => key.includes(`/hour=${newestHour}/`))).toBe(true);
      expect(page.map((e) => e.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => `h0-${String(49 - index).padStart(3, '0')}`),
      );
    });
  });
});
