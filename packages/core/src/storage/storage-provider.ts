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

/**
 * A {@link PruneScope} with a hard cap on how many rows one call may delete —
 * the unit of work behind the pruner's batched delete loop (see
 * {@link StorageProvider.pruneScopedBatch}).
 *
 * `keepLast` is deliberately ABSENT from this type, and that omission is
 * load-bearing rather than an oversight: "keep the newest N of the doomed rows"
 * is a property of the WHOLE matched set, so it cannot be evaluated correctly
 * one bounded batch at a time without re-deriving the reprieve boundary on every
 * batch (a full ordered scan per batch — the opposite of the point). Modelling
 * it out means neither the pruner nor a provider can accidentally combine the
 * two: a `keepLast` scope is a compile error here, and the pruner falls back to
 * the unbounded {@link StorageProvider.pruneScoped} for those scopes.
 */
export interface BoundedPruneScope extends Omit<PruneScope, 'keepLast'> {
  /**
   * Maximum rows this single call may delete. Always >= 1. A provider MUST NOT
   * delete more than this, because the whole point is bounding how long one
   * statement holds locks.
   */
  limit: number;
}

/** Outcome of one bounded delete (see {@link StorageProvider.pruneScopedBatch}). */
export interface BoundedPruneResult {
  /** Rows actually deleted by this call. Never greater than `limit`. */
  deleted: number;
  /**
   * `true` when the provider stopped because it reached `limit` and in-scope
   * rows MAY remain — the pruner's cue to run another batch. `false` means the
   * scope was drained and the pruner stops for this cycle.
   *
   * Being wrong in the `false` direction is safe (the remainder is deleted next
   * cycle); being wrong in the `true` direction only wastes a round-trip, since
   * the loop is also capped by `prune.maxBatchesPerCycle`. Providers SHOULD
   * derive it from the number of rows they SELECTED (`selected === limit`), not
   * from the number they managed to delete — a racing pruner can shrink the
   * latter while plenty of work remains.
   */
  hasMore: boolean;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface EntryWithBatch extends Entry {
  batch: Entry[];
}

/**
 * How much of the tag list to return, for a picker that searches and pages instead of showing a
 * fixed top-N.
 *
 * `search` matches anywhere in the tag, unlike `prefix` which anchors — a picker's search box is the
 * way to reach values a bound cut, and those are rarely reachable by their first characters. Both
 * can be set: `prefix` is the control's fixed scope (`user:`), `search` is what was typed into it.
 */
export interface TagQuery {
  search?: string;
  limit?: number;
  offset?: number;
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
  /**
   * Tag counts for entries matching `prefix`, most-used first with ties broken alphabetically.
   *
   * The order is part of the contract because {@link TagQuery.offset} is: an unordered listing
   * cannot be paged, since page two would be taken over a different arrangement of the same rows and
   * would both repeat and skip.
   *
   * A provider that ignores `query` is still CORRECT, only unbounded — every caller re-applies the
   * bound, so a picker never renders more than it asked for. It just does the work in memory.
   */
  tags(prefix?: string, query?: TagQuery): Promise<TagCount[]>;
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
  /**
   * BOUNDED sibling of {@link pruneScoped}: delete at most `input.limit` of the
   * scope's rows, OLDEST FIRST, and report whether more remain. ADDITIVE and
   * OPTIONAL — providers that omit it keep working, with the pruner falling back
   * to the unbounded `pruneScoped` (and logging the capability warning once).
   *
   * WHY this exists: `pruneScoped` is one unbounded `DELETE`. On a large table
   * whose retention predicate matches nearly every row, the planner correctly
   * picks a full scan, and that ONE statement can hold row locks for tens of
   * minutes — every other writer on the database queues behind it, and a fleet
   * of replicas piles more of them on. Deleting the same rows in short,
   * committed batches releases locks between batches, so the co-tenants of the
   * database get windows even while a badly-behind table is draining.
   *
   * Contract:
   *  - Delete OLDEST FIRST (ascending `createdAt`). Oldest-first is what makes
   *    the loop converge and what makes a partial cycle still reduce the age of
   *    the oldest surviving entry, which is the number retention is judged on.
   *  - Each call MUST be independently committed. Wrapping the whole loop in one
   *    transaction would recreate exactly the long-lock problem this replaces.
   *  - `limit` is a hard cap, not a hint.
   *  - Return `hasMore: true` iff the call was cut short by `limit`.
   *  - Type selection (`type` / `excludeTypes`) is identical to `pruneScoped`.
   *
   * Idempotent and safe to call concurrently: two processes running this against
   * the same store simply race for the same rows and one wins.
   */
  pruneScopedBatch?(input: BoundedPruneScope): Promise<BoundedPruneResult>;
  /**
   * Best-effort NAMED LEASE, backing the default cross-process prune lock
   * (`StorageLeasePruneLock`). ADDITIVE and OPTIONAL; must be implemented
   * together with {@link releaseLease} (see {@link isLeaseCapableStorage}).
   *
   * Atomically grants `key` to `owner` until `nowMs + ttlMs` and returns `true`,
   * IFF one of the following holds at `nowMs`:
   *  - no lease row exists for `key`;
   *  - the existing lease has EXPIRED (`expiresAt <= nowMs`) — this is what stops
   *    a holder that crashed mid-cycle from blocking the fleet forever; or
   *  - the existing lease is already held by this same `owner` (re-entrant
   *    refresh, so a restarted pod with a stable identity is not locked out by
   *    its own previous run).
   *
   * Otherwise it MUST return `false` and leave the row untouched.
   *
   * The check-and-set MUST be atomic against other processes sharing the store,
   * because that atomicity is the entire value of the lease. It does NOT need to
   * be linearizable, fenced, or clock-skew-proof: this lock is ADVISORY. Two
   * winners cost a duplicated delete, never corruption.
   */
  tryAcquireLease?(key: string, owner: string, ttlMs: number, nowMs: number): Promise<boolean>;
  /**
   * Releases a lease previously granted by {@link tryAcquireLease}. MUST be a
   * no-op unless `owner` still holds `key` — otherwise a slow holder whose lease
   * already expired and was re-granted would release SOMEBODY ELSE's lease.
   * MUST be idempotent.
   */
  releaseLease?(key: string, owner: string): Promise<void>;
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

/**
 * A {@link StorageProvider} that supports bounded batched pruning.
 *
 * `pruneScopedBatch` has to stay OPTIONAL on `StorageProvider` — making it
 * required would break every third-party provider on a minor release — but the
 * providers shipped in this repo must all have it. Declaring them
 * `implements BoundedPruneCapable` turns "somebody added a provider, or dropped
 * the method from one, and the pruner silently fell back to a one-hour DELETE"
 * from an invisible production regression into a compile error.
 */
export type BoundedPruneCapable = StorageProvider &
  Required<Pick<StorageProvider, 'pruneScopedBatch'>>;

/**
 * A {@link StorageProvider} that can back the default cross-process prune lock.
 * Same reasoning as {@link BoundedPruneCapable}: optional on the interface for
 * third parties, compile-enforced on the providers in this repo — and it binds
 * the PAIR, so a provider cannot ship `tryAcquireLease` without `releaseLease`
 * and leave the fleet unable to prune until every lease times out.
 */
export type LeaseCapableStorage = StorageProvider &
  Required<Pick<StorageProvider, 'tryAcquireLease' | 'releaseLease'>>;

/**
 * Runtime counterpart of {@link LeaseCapableStorage}: narrows an arbitrary
 * provider (possibly third-party, possibly older than this SPI) to one that can
 * back the default prune lease. Both halves are required — a provider with only
 * one of them is treated as not lease-capable rather than half-used.
 */
export function isLeaseCapableStorage(storage: StorageProvider): storage is LeaseCapableStorage {
  return (
    typeof storage.tryAcquireLease === 'function' && typeof storage.releaseLease === 'function'
  );
}
