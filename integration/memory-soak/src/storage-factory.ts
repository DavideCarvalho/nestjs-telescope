// integration/memory-soak/src/storage-factory.ts
//
// Builds the StorageProvider for a soak cell and, when the cell disables
// rollups, wraps it so the lib's `isRollupStore` duck-type returns false (the
// Recorder then skips the rollup pre-aggregation path entirely).

import {
  type Entry,
  type EntryQuery,
  type EntryWithBatch,
  InMemoryStorageProvider,
  type Page,
  SqliteStorageProvider,
  type StorageProvider,
  type TagCount,
} from '@dudousxd/nestjs-telescope';
import type { SoakConfig, StorageKind } from './config.js';
import { SlowStorageProvider } from './slow-storage.provider.js';

function buildBaseStorage(kind: StorageKind): StorageProvider {
  if (kind === 'in-memory') {
    return new InMemoryStorageProvider();
  }
  if (kind === 'sqlite') {
    return new SqliteStorageProvider({ path: ':memory:' });
  }
  // The incident's remote-RDS stand-in. Delays modelled on observed RDS latency.
  // `SOAK_SLOW_DISCARD=1` makes the store drop entries after the delay, modelling
  // a real off-heap DB (MySQL) that takes the rows off the V8 heap — isolating
  // any retention that is NOT the store's own buffer.
  const discard = process.env.SOAK_SLOW_DISCARD === '1';
  return new SlowStorageProvider({ minDelayMs: 300, maxDelayMs: 800, discard });
}

/**
 * A StorageProvider that delegates entry I/O but deliberately does NOT implement
 * the RollupStore SPI, so `isRollupStore(store)` is false and the rollup path is
 * skipped. Used by the `no rollups` bisection cell.
 */
class NonRollupStorage implements StorageProvider {
  constructor(private readonly inner: StorageProvider) {}

  store(entries: Entry[]): Promise<void> {
    return this.inner.store(entries);
  }
  update(id: string, patch: Partial<Entry>): Promise<void> {
    return this.inner.update(id, patch);
  }
  find(id: string): Promise<EntryWithBatch | null> {
    return this.inner.find(id);
  }
  get(query: EntryQuery): Promise<Page<Entry>> {
    return this.inner.get(query);
  }
  batch(batchId: string): Promise<Entry[]> {
    return this.inner.batch(batchId);
  }
  tags(prefix?: string): Promise<TagCount[]> {
    return this.inner.tags(prefix);
  }
  prune(olderThan: Date, keepLast?: number): Promise<number> {
    return this.inner.prune(olderThan, keepLast);
  }
  clear(): Promise<void> {
    return this.inner.clear();
  }
  init(): void | Promise<void> {
    return this.inner.init?.();
  }
  close(): void | Promise<void> {
    return this.inner.close?.();
  }
}

export function buildStorage(config: SoakConfig): StorageProvider {
  const base = buildBaseStorage(config.storage);
  return config.rollups ? base : new NonRollupStorage(base);
}
