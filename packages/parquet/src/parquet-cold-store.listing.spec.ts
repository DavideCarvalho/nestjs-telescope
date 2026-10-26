import { describe, expect, it } from 'vitest';
import type { ColdLocation, Listing } from './location.js';
import { parquetColdStore } from './parquet-cold-store.js';

const FILES_IN_ONE_HOUR = 20_000;

/** A location whose one day holds a single hour with many small files. */
function crowdedHour(): ColdLocation & { removed: number } {
  const objects = Array.from({ length: FILES_IN_ONE_HOUR }, (_, index) => ({
    key: `type=query/dt=2020-01-01/hour=00/pod-${index}.parquet`,
    size: 100,
  }));
  return {
    describedAs: 'memory',
    removed: 0,
    async list(prefix: string, delimiter?: boolean): Promise<Listing> {
      if (prefix === '' && delimiter) return { prefixes: ['type=query/'], objects: [] };
      if (prefix === 'type=query/' && delimiter) {
        return { prefixes: ['type=query/dt=2020-01-01/'], objects: [] };
      }
      if (prefix === 'type=query/dt=2020-01-01/') return { prefixes: [], objects };
      return { prefixes: [], objects: [] };
    },
    async read(): Promise<ArrayBuffer> {
      throw new Error('not read');
    },
    async write(): Promise<void> {},
    async remove(keys: string[]): Promise<void> {
      this.removed += keys.length;
    },
  };
}

describe('ParquetColdStore listing', () => {
  it('groups a crowded hour in time linear in its file count', async () => {
    const cold = parquetColdStore({
      location: { dir: '/nonexistent' },
      compaction: false,
      retention: { default: '1h' },
    });
    const location = crowdedHour();
    Object.defineProperty(cold, 'location', { value: location });

    const started = performance.now();
    const removed = await cold.expire(Date.UTC(2026, 0, 1));
    const elapsedMs = performance.now() - started;

    expect(removed).toBe(FILES_IN_ONE_HOUR);
    expect(location.removed).toBe(FILES_IN_ONE_HOUR);
    // Re-copying the hour's list per file is ~2 s at this size; one pass is ~ms.
    expect(elapsedMs).toBeLessThan(200);
  });
});
