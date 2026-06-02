import {
  type Entry,
  type EntryQuery,
  type EntryWithBatch,
  type Page,
  type StorageProvider,
  type TagCount,
  isBatchOrigin,
  safeJsonParse,
} from '@dudousxd/nestjs-telescope';
import type { Redis } from 'ioredis';
import { lexMember } from './lex-key.js';

export interface RedisStorageOptions {
  /** Namespace for every Telescope key. Defaults to `'telescope:'`. */
  keyPrefix?: string;
}

const DEFAULT_PREFIX = 'telescope:';
const SCAN_COUNT = 200;

/**
 * Redis-backed shared storage provider (ioredis). Suitable for multi-replica
 * deployments where every instance reads/writes the same store.
 *
 * Key scheme (all prefixed with `keyPrefix`):
 * - `e:<id>`               string  — JSON-serialized {@link Entry}
 * - `idx`                  ZSET    — score 0, member `lexMember(createdAt,id)` (newest-first)
 * - `idx:type:<type>`      ZSET    — same encoding, one per type
 * - `idx:tag:<tag>`        ZSET    — same encoding, one per tag
 * - `idx:family:<fh>`      ZSET    — same encoding, one per family hash
 * - `batch:<batchId>`      ZSET    — score = sequence, member = id
 * - `tags`                 HASH    — tag → count
 *
 * The host owns the injected ioredis connection; {@link close} is a no-op.
 */
export class RedisStorageProvider implements StorageProvider {
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(redis: Redis, options: RedisStorageOptions = {}) {
    this.redis = redis;
    this.prefix = options.keyPrefix ?? DEFAULT_PREFIX;
  }

  async store(entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;

    const pipeline = this.redis.multi();
    for (const entry of entries) {
      const member = lexMember(entry.createdAt.getTime(), entry.id);
      pipeline.set(this.entryKey(entry.id), JSON.stringify(entry));
      pipeline.zadd(this.indexKey(), 0, member);
      pipeline.zadd(this.typeIndexKey(entry.type), 0, member);
      if (entry.familyHash !== null) {
        pipeline.zadd(this.familyIndexKey(entry.familyHash), 0, member);
      }
      pipeline.zadd(this.batchKey(entry.batchId), entry.sequence, entry.id);
      for (const tag of entry.tags) {
        pipeline.zadd(this.tagIndexKey(tag), 0, member);
        pipeline.hincrby(this.tagsKey(), tag, 1);
      }
    }
    await pipeline.exec();
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const raw = await this.redis.get(this.entryKey(id));
    if (raw === null) return null;
    const entry = this.parseEntry(raw);
    if (entry === null) return null;
    return { ...entry, batch: await this.batch(entry.batchId) };
  }

  async batch(batchId: string): Promise<Entry[]> {
    const ids = await this.redis.zrange(this.batchKey(batchId), 0, -1);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => this.entryKey(id)));
    const entries: Entry[] = [];
    for (const raw of raws) {
      if (raw === null) continue;
      const entry = this.parseEntry(raw);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }

  async tags(prefix?: string): Promise<TagCount[]> {
    const hash = await this.redis.hgetall(this.tagsKey());
    const result: TagCount[] = [];
    for (const [tag, rawCount] of Object.entries(hash)) {
      const count = Number(rawCount);
      if (count <= 0) continue;
      if (prefix !== undefined && !tag.startsWith(prefix)) continue;
      result.push({ tag, count });
    }
    return result;
  }

  async clear(): Promise<void> {
    const pattern = `${this.prefix}*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
      cursor = next;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== '0');
  }

  async get(_query: EntryQuery): Promise<Page<Entry>> {
    throw new Error('RedisStorageProvider.get is implemented in Task 4');
  }

  async update(_id: string, _patch: Partial<Entry>): Promise<void> {
    throw new Error('RedisStorageProvider.update is implemented in Task 4');
  }

  async prune(_olderThan: Date, _keepLast?: number): Promise<number> {
    throw new Error('RedisStorageProvider.prune is implemented in Task 4');
  }

  /** The host owns the injected connection, so closing it is its responsibility. */
  close(): void {
    // no-op
  }

  /**
   * Resiliently parse a stored entry: bad JSON yields null (dropped by callers),
   * and `createdAt` is revived from its ISO string back into a Date.
   */
  private parseEntry(raw: string): Entry | null {
    const parsed = safeJsonParse<Record<string, unknown> | null>(raw, null);
    if (parsed === null || typeof parsed !== 'object') return null;
    const candidate = parsed as Omit<Partial<Entry>, 'createdAt'> & { createdAt?: unknown };
    if (typeof candidate.id !== 'string' || typeof candidate.batchId !== 'string') {
      return null;
    }
    const createdAt =
      typeof candidate.createdAt === 'string' || typeof candidate.createdAt === 'number'
        ? new Date(candidate.createdAt)
        : new Date(Number.NaN);
    return {
      id: candidate.id,
      batchId: candidate.batchId,
      type: typeof candidate.type === 'string' ? candidate.type : '',
      familyHash: typeof candidate.familyHash === 'string' ? candidate.familyHash : null,
      content: candidate.content ?? {},
      tags: Array.isArray(candidate.tags) ? candidate.tags : [],
      sequence: typeof candidate.sequence === 'number' ? candidate.sequence : 0,
      durationMs: typeof candidate.durationMs === 'number' ? candidate.durationMs : null,
      origin: isBatchOrigin(candidate.origin) ? candidate.origin : 'manual',
      instanceId: typeof candidate.instanceId === 'string' ? candidate.instanceId : '',
      createdAt,
    };
  }

  private entryKey(id: string): string {
    return `${this.prefix}e:${id}`;
  }

  private indexKey(): string {
    return `${this.prefix}idx`;
  }

  private typeIndexKey(type: string): string {
    return `${this.prefix}idx:type:${type}`;
  }

  private tagIndexKey(tag: string): string {
    return `${this.prefix}idx:tag:${tag}`;
  }

  private familyIndexKey(familyHash: string): string {
    return `${this.prefix}idx:family:${familyHash}`;
  }

  private batchKey(batchId: string): string {
    return `${this.prefix}batch:${batchId}`;
  }

  private tagsKey(): string {
    return `${this.prefix}tags`;
  }
}
