// integration/memory-soak/src/slow-storage.provider.ts
//
// A StorageProvider whose every write awaits a configurable delay, modelling the
// incident's remote MySQL/RDS round-trip. It is the backpressure candidate: if a
// flush takes ~300-800ms while entries keep arriving, anything that retains the
// in-flight or queued entries grows unbounded. It delegates reads/structure to a
// real InMemoryStorageProvider so the rest of the app behaves normally.

import {
  type Entry,
  type EntryQuery,
  type EntryWithBatch,
  InMemoryStorageProvider,
  type Page,
  type RollupBucket,
  type RollupDelta,
  type RollupStore,
  type StorageProvider,
  type TagCount,
} from '@dudousxd/nestjs-telescope';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface SlowStorageOptions {
  /** Lower bound of the simulated round-trip, in ms. */
  minDelayMs: number;
  /** Upper bound of the simulated round-trip, in ms. */
  maxDelayMs: number;
  /**
   * When true, the backing store DISCARDS entries after the delay instead of
   * retaining them — isolating "does the slow store itself retain?" from "does
   * something upstream retain while the store is slow?".
   */
  discard: boolean;
}

/**
 * Slow, delegating storage. Models a remote DB: `store()`/`recordRollups()`
 * await a random delay in [minDelayMs, maxDelayMs] before the backing in-memory
 * store accepts the batch. Reads pass straight through.
 */
export class SlowStorageProvider implements StorageProvider, RollupStore {
  private readonly backing = new InMemoryStorageProvider();

  constructor(private readonly options: SlowStorageOptions) {}

  private delay(): Promise<void> {
    const { minDelayMs, maxDelayMs } = this.options;
    const span = Math.max(0, maxDelayMs - minDelayMs);
    return sleep(minDelayMs + Math.floor(Math.random() * (span + 1)));
  }

  async store(entries: Entry[]): Promise<void> {
    await this.delay();
    if (this.options.discard) return;
    await this.backing.store(entries);
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    await this.delay();
    await this.backing.update(id, patch);
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    return this.backing.find(id);
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    return this.backing.get(query);
  }

  async batch(batchId: string): Promise<Entry[]> {
    return this.backing.batch(batchId);
  }

  async tags(prefix?: string): Promise<TagCount[]> {
    return this.backing.tags(prefix);
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    return this.backing.prune(olderThan, keepLast);
  }

  async clear(): Promise<void> {
    await this.backing.clear();
  }

  async recordRollups(deltas: RollupDelta[]): Promise<void> {
    await this.delay();
    if (this.options.discard) return;
    await this.backing.recordRollups(deltas);
  }

  async queryRollups(
    metrics: string[],
    fromBucket: number,
    toBucket: number,
  ): Promise<RollupBucket[]> {
    return this.backing.queryRollups(metrics, fromBucket, toBucket);
  }
}
