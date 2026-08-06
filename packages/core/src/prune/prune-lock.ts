// packages/core/src/prune/prune-lock.ts
//
// The cross-process prune lock seam.
//
// The pruner's in-flight guard bounds ONE PROCESS to one prune cycle. A
// deployment of N replicas sharing one store still runs N cycles at once, all
// deleting the same rows. That is not incorrect — the deletes are idempotent and
// one of them wins each row — it is pure waste, and on a store that is already
// behind the waste is what keeps it behind.
//
// So this seam is deliberately SMALL and deliberately ADVISORY. It is a named
// lock with a lease: acquire, release, and a way to say "somebody else has it".
// There is no fencing token, no renewal, no quorum, and none of that is an
// oversight — a lost lease costs one duplicated DELETE, never a wrong result, so
// paying for consensus here would be paying for nothing.
//
// Telescope must not depend on a job engine, a Redis client, or anything else
// the host may not have: it mounts into any NestJS app. Hence the seam plus a
// default implementation that rides the database Telescope already has (see
// `StorageLeasePruneLock`), and an escape hatch for a host that already owns a
// better primitive (`prune.lock`).

import type { LeaseCapableStorage } from '../storage/storage-provider.js';

/**
 * The lock name the pruner asks for. Deliberately a single fleet-wide constant:
 * every replica pruning the SAME store is exactly the set that should contend,
 * and two apps sharing one Telescope store share the entries table too, so they
 * should share the lock as well.
 */
export const PRUNE_LOCK_KEY = 'telescope:prune';

/**
 * A lease that was successfully acquired. Handed back inside a
 * {@link TelescopePruneLockResult} so it is unreachable without first checking
 * that the acquire actually succeeded.
 */
export interface TelescopePruneLease {
  /** The lock name this lease covers. */
  readonly key: string;
  /** The holder identity that was granted the lease. */
  readonly owner: string;
  /**
   * Epoch-ms after which the lease is considered abandoned and MAY be granted to
   * somebody else, even if `release` was never called. This is what makes a pod
   * that dies mid-prune cost one TTL of fleet-wide silence rather than forever.
   */
  readonly expiresAtMs: number;
  /**
   * Gives the lease up early. MUST be idempotent, MUST NOT throw (swallow and,
   * at most, log — the TTL is the backstop), and MUST NOT release the lease if
   * this holder's lease already expired and was re-granted to somebody else.
   */
  release(): Promise<void>;
}

/**
 * The result of an acquire attempt, as a discriminated union so the `lease` is
 * unreachable until `acquired` has been narrowed — a caller physically cannot
 * forget to handle "somebody else has it".
 *
 * `reason` distinguishes the two failures because the pruner treats them
 * OPPOSITELY:
 *  - `'held'` — a healthy, expected outcome. Another replica is pruning; this
 *    one stands down silently and tries again next tick.
 *  - `'unavailable'` — the lock MECHANISM failed (backend down, table missing,
 *    permissions). The pruner then FAILS OPEN and prunes anyway, because a
 *    broken lock must not become "retention silently stops and the table grows
 *    without bound". Failing open is at worst today's behaviour.
 *
 * Getting this distinction wrong in a host implementation is the one thing that
 * really hurts, so: if you cannot tell the two apart, return `'unavailable'`.
 */
export type TelescopePruneLockResult =
  | { readonly acquired: true; readonly lease: TelescopePruneLease }
  | {
      readonly acquired: false;
      readonly reason: 'held' | 'unavailable';
      /** Optional human-readable detail, surfaced in the pruner's log line. */
      readonly detail?: string;
    };

/** The request handed to {@link TelescopePruneLock.acquire}. */
export interface TelescopePruneLockRequest {
  /** Lock name. Always {@link PRUNE_LOCK_KEY} today; an object so it can grow. */
  readonly key: string;
  /**
   * Identity of the process asking. Stable for the life of the process and
   * distinct between replicas (the pruner uses `<instanceId>#<pid>`).
   */
  readonly owner: string;
  /**
   * How long the lease should survive without a release. The pruner derives it
   * from `prune.lockTtlMs`, defaulted to three prune intervals, so a crashed
   * holder costs at most that much fleet-wide silence.
   */
  readonly ttlMs: number;
}

/**
 * The seam. Implement this in the host to back Telescope's prune lock with a
 * primitive you already run — e.g. a durable-workflow singleton mutex, a Redis
 * SET NX PX, a Postgres advisory lock.
 *
 * ## Contract (all of it)
 *
 * 1. `acquire` MUST NOT throw. Return `{ acquired: false, reason: 'unavailable' }`
 *    instead. (The pruner catches a throw and treats it as `'unavailable'`
 *    anyway, but a host that relies on that is relying on a backstop.)
 * 2. `acquire` MUST be atomic across processes for a given `key`: at most one
 *    caller gets `acquired: true` while a lease is live.
 * 3. A lease MUST expire on its own after roughly `ttlMs` even if `release` is
 *    never called. A holder that is SIGKILLed must not wedge the fleet.
 * 4. Re-acquiring with the SAME `owner` while that owner still holds the lease
 *    SHOULD succeed (refresh), so a restart with a stable identity is not locked
 *    out by its own previous lease.
 * 5. `lease.release()` MUST be idempotent, MUST NOT throw, and MUST NOT release a
 *    lease that has since been granted to a different owner.
 * 6. Precision is NOT required. Clock skew, an expiry that fires while the
 *    holder is still working, two simultaneous winners — all acceptable. The
 *    lock is advisory; the only cost of getting it wrong is a duplicated delete.
 * 7. `acquire` SHOULD return promptly and MUST NOT block waiting for the lock.
 *    The pruner treats "held" as "skip this tick", not "queue up" — waiting
 *    would rebuild the pile-up this whole change exists to remove.
 *
 * ## What the pruner does with it
 *
 * Once per cycle, before any delete: `acquire({ key, owner, ttlMs })`. On
 * `'held'` the cycle is skipped entirely (no `PruneRun` is recorded, `pruneNow()`
 * resolves `0`). On `'unavailable'` the cycle runs unlocked and one warning is
 * logged per streak. On success the cycle runs and the lease is released in a
 * `finally`, whether the cycle succeeded, failed, or threw.
 *
 * @example a host implementation over a singleton-mutex job engine
 * ```ts
 * class DurablePruneLock implements TelescopePruneLock {
 *   constructor(private readonly durable: DurableClient) {}
 *   async acquire({ key, owner, ttlMs }: TelescopePruneLockRequest) {
 *     try {
 *       const started = await this.durable.tryStartSingleton(key, { ttlMs, owner });
 *       if (!started) return pruneLockHeld('another pod holds the singleton');
 *       return pruneLockAcquired({
 *         key,
 *         owner,
 *         expiresAtMs: Date.now() + ttlMs,
 *         release: () => this.durable.finishSingleton(key, owner).catch(() => undefined),
 *       });
 *     } catch (error) {
 *       return pruneLockUnavailable(String(error));
 *     }
 *   }
 * }
 * ```
 */
export interface TelescopePruneLock {
  acquire(request: TelescopePruneLockRequest): Promise<TelescopePruneLockResult>;
}

/** Builds the success arm of a {@link TelescopePruneLockResult}. */
export function pruneLockAcquired(lease: TelescopePruneLease): TelescopePruneLockResult {
  return { acquired: true, lease };
}

/** Builds the "somebody else has it" arm — the healthy, expected refusal. */
export function pruneLockHeld(detail?: string): TelescopePruneLockResult {
  return detail === undefined
    ? { acquired: false, reason: 'held' }
    : { acquired: false, reason: 'held', detail };
}

/** Builds the "the lock mechanism itself failed" arm — the pruner fails OPEN on this. */
export function pruneLockUnavailable(detail?: string): TelescopePruneLockResult {
  return detail === undefined
    ? { acquired: false, reason: 'unavailable' }
    : { acquired: false, reason: 'unavailable', detail };
}

/**
 * The DEFAULT prune lock: a lease row in the store Telescope is already using.
 *
 * Telescope always has a database — that is where the entries live — so a lease
 * with an owner and an expiry costs no new dependency, no new deployment
 * concern, and works on every provider that implements the lease SPI. A holder
 * that dies never releases; the expiry is what reclaims it, which is why the SPI
 * takes a TTL rather than a plain "locked" flag.
 *
 * Used automatically when the configured provider {@link isLeaseCapableStorage}
 * and the host supplied no `prune.lock` of its own.
 */
export class StorageLeasePruneLock implements TelescopePruneLock {
  constructor(private readonly storage: LeaseCapableStorage) {}

  async acquire(request: TelescopePruneLockRequest): Promise<TelescopePruneLockResult> {
    const { key, owner, ttlMs } = request;
    const acquiredAtMs = Date.now();
    let granted: boolean;
    try {
      granted = await this.storage.tryAcquireLease(key, owner, ttlMs, acquiredAtMs);
    } catch (error: unknown) {
      // A store that cannot answer must not stop retention: report the MECHANISM
      // as broken (not "held") so the pruner fails open and prunes unlocked.
      return pruneLockUnavailable(error instanceof Error ? error.message : String(error));
    }
    if (!granted) return pruneLockHeld();
    return pruneLockAcquired({
      key,
      owner,
      expiresAtMs: acquiredAtMs + ttlMs,
      release: async (): Promise<void> => {
        try {
          await this.storage.releaseLease(key, owner);
        } catch {
          // Never throw out of release: the TTL already guarantees the lease is
          // reclaimed, so a failed release delays the next cycle at worst.
        }
      },
    });
  }
}
