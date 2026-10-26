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

/**
 * Counts the elements walked by array iteration (spread, `for…of`, `Array.from`) while
 * installed, by wrapping `Array.prototype[Symbol.iterator]`.
 */
function countArrayIteration(): { elements: () => number; restore: () => void } {
  const original = Array.prototype[Symbol.iterator];
  let elements = 0;
  Array.prototype[Symbol.iterator] = function counted(this: unknown[]) {
    elements += this.length;
    return original.call(this);
  } as typeof original;
  return {
    elements: () => elements,
    restore: () => {
      Array.prototype[Symbol.iterator] = original;
    },
  };
}

describe('ParquetColdStore listing', () => {
  it('groups a crowded hour with work linear in its file count', async () => {
    const cold = parquetColdStore({
      location: { dir: '/nonexistent' },
      compaction: false,
      retention: { default: '1h' },
    });
    const location = crowdedHour();
    Object.defineProperty(cold, 'location', { value: location });

    const iterated = countArrayIteration();
    let removed: number;
    try {
      removed = await cold.expire(Date.UTC(2026, 0, 1));
    } finally {
      iterated.restore();
    }

    expect(removed).toBe(FILES_IN_ONE_HOUR);
    expect(location.removed).toBe(FILES_IN_ONE_HOUR);
    // Re-copying the hour's list per file iterates ~n²/2 elements (2e8 here); one pass is a few n.
    expect(iterated.elements()).toBeLessThan(10 * FILES_IN_ONE_HOUR);
  });
});
