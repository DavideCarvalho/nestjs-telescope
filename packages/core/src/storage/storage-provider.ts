// packages/core/src/storage/storage-provider.ts
import type { Entry } from '../entry/entry.js';

export interface EntryQuery {
  type?: string;
  tag?: string;
  familyHash?: string;
  batchId?: string;
  /** When set, only entries whose traceId matches are returned. */
  traceId?: string;
  /**
   * Free-text filter: a case-insensitive substring matched against the entry's
   * serialized `content` (so a request matches by uri, a query by sql, a cache op
   * by key, an exception by message, etc.). Applied as an extra AND predicate, so
   * it composes with every other filter and with keyset pagination, and it is
   * independent of `omitContent` (the match runs over the stored content before
   * the projection nulls it). A deliberate user action; a `content LIKE` scan is
   * acceptable.
   */
  search?: string;
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
  /**
   * When true, the returned entries carry `content: null` and the provider
   * SHOULD avoid reading/parsing the (potentially large) content column where
   * its driver supports a projection. This powers content-less aggregate scans
   * (pulse/timeseries) that only need small columns. Providers that store the
   * whole entry as one blob (e.g. Redis) cannot project and MUST still null the
   * content after parse so callers can never depend on it.
   */
  omitContent?: boolean;
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
  /**
   * Acquire resources / ensure schema. Optional; called ONCE at application boot,
   * before any other method, and awaited by the module during startup. Providers
   * with no startup work omit it.
   */
  init?(): void | Promise<void>;
  /**
   * Release PROVIDER-OWNED resources (DB handle, connection pool). Optional.
   * Called ONCE at shutdown, AFTER the final flush, and ALWAYS — so a provider
   * that BORROWS a host-owned resource (e.g. a shared connection) must implement
   * this as a no-op. Providers with no owned resources omit it.
   */
  close?(): void | Promise<void>;
}
