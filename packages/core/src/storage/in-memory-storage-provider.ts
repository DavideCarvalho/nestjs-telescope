// packages/core/src/storage/in-memory-storage-provider.ts
import type { Entry } from '../entry/entry.js';
import type {
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
} from './storage-provider.js';

const DEFAULT_LIMIT = 50;

/**
 * Process-local store. Used as a test double and as a zero-dependency option
 * for single-instance/serverless setups. Newest-first ordering by createdAt
 * then id; cursor is the last seen entry id (keyset pagination).
 */
export class InMemoryStorageProvider implements StorageProvider {
  private entries: Entry[] = [];

  async store(entries: Entry[]): Promise<void> {
    this.entries.push(...entries);
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index !== -1) {
      const existing = this.entries[index];
      if (existing) {
        this.entries[index] = { ...existing, ...patch, id: existing.id };
      }
    }
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      return null;
    }
    return { ...entry, batch: await this.batch(entry.batchId) };
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    const ordered = [...this.entries]
      .filter((entry) => this.matches(entry, query))
      .sort(this.newestFirst);

    let start = 0;
    if (query.cursor) {
      const cursorIndex = ordered.findIndex((entry) => entry.id === query.cursor);
      start = cursorIndex === -1 ? ordered.length : cursorIndex + 1;
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    const slice = ordered.slice(start, start + limit);
    const last = slice.at(-1);
    const hasMore = last ? start + limit < ordered.length : false;
    return { data: slice, nextCursor: hasMore && last ? last.id : null };
  }

  async batch(batchId: string): Promise<Entry[]> {
    return this.entries
      .filter((entry) => entry.batchId === batchId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async tags(prefix?: string): Promise<TagCount[]> {
    const counts = new Map<string, number>();
    for (const entry of this.entries) {
      for (const tag of entry.tags) {
        if (!prefix || tag.startsWith(prefix)) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count }));
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    const before = this.entries.length;
    let survivors = this.entries.filter((entry) => entry.createdAt >= olderThan);
    if (keepLast !== undefined && survivors.length < this.entries.length) {
      const pruned = [...this.entries]
        .filter((entry) => entry.createdAt < olderThan)
        .sort(this.newestFirst)
        .slice(0, keepLast);
      survivors = [...survivors, ...pruned];
    }
    this.entries = survivors;
    return before - this.entries.length;
  }

  async clear(): Promise<void> {
    this.entries = [];
  }

  private matches(entry: Entry, query: EntryQuery): boolean {
    if (query.type && entry.type !== query.type) return false;
    if (query.tag && !entry.tags.includes(query.tag)) return false;
    if (query.familyHash && entry.familyHash !== query.familyHash) return false;
    if (query.batchId && entry.batchId !== query.batchId) return false;
    if (query.before && entry.createdAt >= query.before) return false;
    if (query.after && entry.createdAt <= query.after) return false;
    return true;
  }

  private newestFirst = (a: Entry, b: Entry): number => {
    const delta = b.createdAt.getTime() - a.createdAt.getTime();
    return delta !== 0 ? delta : b.id.localeCompare(a.id);
  };
}
