// packages/core/src/storage/storage-provider.ts
import type { Entry } from '../entry/entry.js';

export interface EntryQuery {
  type?: string;
  tag?: string;
  familyHash?: string;
  batchId?: string;
  before?: Date;
  after?: Date;
  /**
   * Keyset cursor: the `id` of the last entry seen in the previous page.
   * If the entry no longer exists (e.g. it was pruned), the page is empty
   * with `nextCursor: null`; callers should restart pagination without a cursor.
   */
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface EntryWithBatch extends Entry {
  batch: Entry[];
}

export interface StorageProvider {
  store(entries: Entry[]): Promise<void>;
  /** Patches `patch` fields onto the entry with the given `id`. The `id` field is immutable; other fields are patched as given. */
  update(id: string, patch: Partial<Entry>): Promise<void>;
  /** Returned entry and its batch members may share object references with the store; callers must not mutate them. */
  find(id: string): Promise<EntryWithBatch | null>;
  /**
   * Returns a page of entries matching `query`, sorted newest-first.
   * If `query.cursor` refers to an entry that no longer exists (e.g. pruned),
   * the page is empty with `nextCursor: null`; callers should restart pagination without a cursor.
   */
  get(query: EntryQuery): Promise<Page<Entry>>;
  /** Returned entries may share object references with the store; callers must not mutate them. */
  batch(batchId: string): Promise<Entry[]>;
  /** Returns tag counts for entries matching `prefix`. The returned order is unspecified. */
  tags(prefix?: string): Promise<TagCount[]>;
  prune(olderThan: Date, keepLast?: number): Promise<number>;
  clear(): Promise<void>;
}
