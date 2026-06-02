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
   * Opaque keyset cursor representing a (createdAt, id) position.
   * `get` returns entries strictly older than this position.
   * If the cursor's original entry was since removed (e.g. pruned), pagination
   * RESUMES from that position rather than returning an empty page.
   * An undecodable cursor is silently ignored and pagination starts from the first page.
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
   * `query.cursor` is an opaque keyset position; entries strictly older than it are returned.
   * If the cursor's original entry was since removed (e.g. pruned), pagination RESUMES from
   * that position (not empty). An undecodable cursor starts from the first page.
   */
  get(query: EntryQuery): Promise<Page<Entry>>;
  /** Returned entries may share object references with the store; callers must not mutate them. */
  batch(batchId: string): Promise<Entry[]>;
  /** Returns tag counts for entries matching `prefix`. The returned order is unspecified. */
  tags(prefix?: string): Promise<TagCount[]>;
  prune(olderThan: Date, keepLast?: number): Promise<number>;
  clear(): Promise<void>;
  /** Release any held resources (DB handle, connections). Optional; providers
   *  without resources omit it. The module closes a store it created on shutdown. */
  close?(): void | Promise<void>;
}
