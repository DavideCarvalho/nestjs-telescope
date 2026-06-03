// packages/mikro-orm/src/mikro-orm-storage.provider.ts
//
// A StorageProvider that persists Telescope entries to MySQL/SQLite via MikroORM.
//
// Design notes:
//
//  - Per-op `em.fork()`: storage runs OUTSIDE the request scope (entries are
//    flushed from a background buffer, pruned by a scheduler, etc.), so every
//    method forks a fresh EntityManager. A fork has an empty identity map, which
//    avoids leaking stale managed entities across unrelated operations and is
//    safe for concurrent use across pods/requests.
//
//  - Keyset pagination: `get` returns entries newest-first (createdAt DESC, id
//    DESC tiebreak). A cursor encodes a (createdAt, id) POSITION — not an id
//    lookup — so "strictly older than the cursor" is expressed as the $or
//    `[{ createdAt < d }, { createdAt = d, id < cursorId }]`. Because it is a
//    position, pagination resumes correctly even if the cursor's original entry
//    was pruned. We fetch limit+1 rows to decide whether a next page exists.
//
//  - tagsText LIKE tag filtering: JSON-array querying is not portable across
//    MySQL and SQLite, so tag filters run against the space-padded `tagsText`
//    column via `LIKE '% <tag> %'`. The leading/trailing spaces make the first
//    and last tag matchable and prevent substring false-positives ('slow' must
//    not match 'slowest'). The `tags` JSON column stays the source of truth.
//
//  - Operational caveat: high-volume observability writes land on the same DB.
//    On a busy primary this adds non-trivial write load — consider pointing this
//    provider at a separate connection/database in production.
//
import type {
  Entry,
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
} from '@dudousxd/nestjs-telescope';
import { decodeCursor, encodeCursor, isBatchOrigin } from '@dudousxd/nestjs-telescope';
import type { EntityManager, FilterQuery } from '@mikro-orm/core';
import { TelescopeEntry, type TelescopeEntryRow } from './telescope-entry.entity.js';

const DEFAULT_LIMIT = 50;

function padTags(tags: string[]): string {
  return tags.length ? ` ${tags.join(' ')} ` : ' ';
}

function rowToEntry(row: TelescopeEntryRow): Entry {
  return {
    id: row.id,
    batchId: row.batchId,
    type: row.type,
    familyHash: row.familyHash,
    content: row.content,
    tags: row.tags,
    sequence: row.sequence,
    durationMs: row.durationMs,
    origin: isBatchOrigin(row.origin) ? row.origin : 'manual',
    instanceId: row.instanceId,
    createdAt: row.createdAt,
  };
}

function entryToRowData(entry: Entry): TelescopeEntryRow {
  return { ...entry, tagsText: padTags(entry.tags) };
}

function resolveLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
}

export class MikroOrmStorageProvider implements StorageProvider {
  constructor(private readonly em: EntityManager) {}

  async store(entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const em = this.em.fork();
    for (const entry of entries) {
      em.create(TelescopeEntry, entryToRowData(entry));
    }
    await em.flush();
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const em = this.em.fork();
    const row = await em.findOne(TelescopeEntry, { id });
    if (!row) return;

    const { id: _ignoredId, ...rest } = patch;
    const patchData: Partial<TelescopeEntryRow> = { ...rest };
    if (patch.tags !== undefined) {
      patchData.tagsText = padTags(patch.tags);
    }
    em.assign(row, patchData);
    await em.flush();
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const em = this.em.fork();
    const row = await em.findOne(TelescopeEntry, { id });
    if (!row) return null;
    const batch = await this.batch(row.batchId);
    return { ...rowToEntry(row), batch };
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    const em = this.em.fork();
    const where: FilterQuery<TelescopeEntryRow> = {};

    if (query.type) where.type = query.type;
    if (query.familyHash) where.familyHash = query.familyHash;
    if (query.batchId) where.batchId = query.batchId;
    if (query.tag) where.tagsText = { $like: `% ${query.tag} %` };

    if (query.before || query.after) {
      where.createdAt = {
        ...(query.after && { $gt: query.after }),
        ...(query.before && { $lt: query.before }),
      };
    }

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor) {
      const cursorDate = new Date(cursor.createdAt);
      where.$or = [
        { createdAt: { $lt: cursorDate } },
        { createdAt: cursorDate, id: { $lt: cursor.id } },
      ];
    }

    const limit = resolveLimit(query.limit);
    const rows = await em.find(TelescopeEntry, where, {
      orderBy: { createdAt: 'desc', id: 'desc' },
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const last = slice.at(-1);
    const nextCursor =
      hasMore && last ? encodeCursor(last.createdAt.getTime(), last.id) : null;

    return { data: slice.map(rowToEntry), nextCursor };
  }

  async batch(batchId: string): Promise<Entry[]> {
    const em = this.em.fork();
    const rows = await em.find(TelescopeEntry, { batchId }, { orderBy: { sequence: 'asc' } });
    return rows.map(rowToEntry);
  }

  async tags(prefix?: string): Promise<TagCount[]> {
    const em = this.em.fork();
    const rows = await em.find(
      TelescopeEntry,
      {},
      { orderBy: { createdAt: 'desc', id: 'desc' }, limit: 10000, fields: ['tags'] },
    );

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags) {
        if (prefix && !tag.startsWith(prefix)) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count }));
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    const em = this.em.fork();
    if (keepLast === undefined) {
      return em.nativeDelete(TelescopeEntry, { createdAt: { $lt: olderThan } });
    }

    const older = await em.find(
      TelescopeEntry,
      { createdAt: { $lt: olderThan } },
      { orderBy: { createdAt: 'desc', id: 'desc' }, fields: ['id'] },
    );
    const toDelete = older.slice(keepLast).map((row) => row.id);
    if (toDelete.length === 0) return 0;
    return em.nativeDelete(TelescopeEntry, { id: { $in: toDelete } });
  }

  async clear(): Promise<void> {
    const em = this.em.fork();
    await em.nativeDelete(TelescopeEntry, {});
  }
}
