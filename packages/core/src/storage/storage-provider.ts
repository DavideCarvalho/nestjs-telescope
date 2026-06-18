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
  /**
   * When set, only entries whose `id` is in this set are returned, combined with
   * every other filter via AND. Intended for batched hydration: callers that have
   * already determined a handful of ids (e.g. pulse's displayed rows) fetch all of
   * their content in ONE query instead of N per-id `find()` round-trips. An empty
   * array returns no entries.
   */
  ids?: string[];
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

/**
 * A single type-scoped prune request (see {@link StorageProvider.pruneScoped}).
 * `type` and `excludeTypes` are mutually exclusive: set `type` to prune ONE type,
 * or `excludeTypes` to prune everything EXCEPT a set (the global bulk delete with
 * the per-type-overridden types carved out). Neither set means "all types".
 */
export interface PruneScope {
  /** Delete entries strictly older than this instant. */
  before: Date;
  /** When set, restrict the delete to this single entry type. */
  type?: string;
  /** When set, delete every type EXCEPT these (the global non-overridden bulk). */
  excludeTypes?: string[];
  /** Keep the newest N of the matched-and-doomed rows, as in {@link StorageProvider.prune}. */
  keepLast?: number;
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
  /**
   * Type-scoped prune for per-type retention. ADDITIVE and OPTIONAL: providers
   * that predate per-type retention omit it, and the pruner falls back to the
   * global {@link StorageProvider.prune} (logging a one-time warn) so third-party
   * providers keep working — at the cost of using the global cutoff for everyone.
   *
   * The pruner drives one call per distinct cutoff per cycle:
   *  - the global cutoff with `excludeTypes` set to the overridden types, which
   *    must delete every entry older than `before` whose `type` is NOT in that
   *    list (`WHERE created_at < ? AND type NOT IN (...)`); and
   *  - one call per overridden type with `type` set (`WHERE created_at < ? AND
   *    type = ?`).
   *
   * `type` and `excludeTypes` are mutually exclusive. `keepLast`, when set, has
   * the SAME meaning as in `prune`: keep the newest N of the matched-and-doomed
   * rows. Returns the number of rows deleted.
   */
  pruneScoped?(input: PruneScope): Promise<number>;
  clear(): Promise<void>;
  /**
   * SHARED dedup for the `new-exception` alert. ADDITIVE and OPTIONAL.
   *
   * Atomically records that `familyHash` was observed at `nowMs` and returns
   * `true` IFF this is a genuinely NEW occurrence for the trailing `windowMs`
   * (never seen, or last seen longer ago than the window) — the exact signal that
   * should fire the alert. The check-and-update MUST be atomic so that, with
   * multiple replicas writing to the SAME store, only ONE replica sees `true` for
   * a brand-new family (the others see `false`): a family pages ONCE across the
   * whole deployment instead of once per pod.
   *
   * Providers that omit this fall back to the alerter's in-memory per-replica
   * tracker (the documented v1 "once per pod" behaviour), so existing/3rd-party
   * providers keep working unchanged.
   */
  markFamilySeen?(familyHash: string, nowMs: number, windowMs: number): Promise<boolean>;
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
