// packages/core/src/storage/storage-provider.ts
import type { Entry } from '../entry/entry.js';

export interface EntryQuery {
  type?: string;
  tag?: string;
  familyHash?: string;
  batchId?: string;
  before?: Date;
  after?: Date;
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
  update(id: string, patch: Partial<Entry>): Promise<void>;
  find(id: string): Promise<EntryWithBatch | null>;
  get(query: EntryQuery): Promise<Page<Entry>>;
  batch(batchId: string): Promise<Entry[]>;
  tags(prefix?: string): Promise<TagCount[]>;
  prune(olderThan: Date, keepLast?: number): Promise<number>;
  clear(): Promise<void>;
}
