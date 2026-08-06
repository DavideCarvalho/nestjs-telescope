// packages/core/src/nest/telescope-pruner.service.ts
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { TelescopePruneLock } from '../prune/prune-lock.js';
import {
  PRUNE_LOCK_KEY,
  StorageLeasePruneLock,
  pruneLockUnavailable,
} from '../prune/prune-lock.js';
import type {
  BoundedPruneScope,
  PruneScope,
  StorageProvider,
} from '../storage/storage-provider.js';
import { isLeaseCapableStorage } from '../storage/storage-provider.js';
import { TELESCOPE_CONFIG, TELESCOPE_STORAGE } from './telescope.options.js';

/** What kicked off a prune cycle: the interval timer, or an on-demand request. */
export type PruneTrigger = 'scheduled' | 'manual';

/**
 * One recorded prune cycle, kept in an in-memory ring buffer on the pruner so
 * the dashboard's Prunes screen can show retention activity. Like the
 * server-stats history ring this is PER-POD (each replica records its own
 * cycles); prune runs are deliberately NOT stored as telescope entries — they
 * would be pruned themselves and add write load to the very store retention is
 * meant to shrink.
 */
export interface PruneRun {
  /** ISO timestamp when the cycle started. */
  at: string;
  trigger: PruneTrigger;
  /** Wall-clock duration of the whole cycle. */
  durationMs: number;
  /** Total entries deleted across the bulk delete and every per-type scope. */
  deletedTotal: number;
  /**
   * Real per-type delete counts for the individually-handled scopes (entry
   * types with a `perType` override or an archived type, each pruned in its own
   * scope at its own cutoff). The global bulk delete spans every other type and
   * returns a single aggregate count from the storage SPI, so it is folded into
   * `deletedTotal` only — it is never attributed to a fabricated type key here.
   */
  deletedByType: Record<string, number>;
  /** Entries handed to the archive sink before deletion this cycle, if any. */
  archivedTotal?: number;
  /** First step error message captured this cycle (steps still swallow + log). */
  error?: string;
}

/** Outcome of one archive-then-delete scope step, accumulated into a run. */
interface PruneStepResult {
  deleted: number;
  archived: number;
  error?: string;
}

/** Ring-buffer cap for recent prune runs (newest-first). */
const MAX_PRUNE_RUNS = 100;

@Injectable()
export class TelescopePruner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TelescopePruner.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Latches once after the FIRST time we fall back from a missing
   * `pruneScoped` to the global `prune`, so a third-party provider without
   * per-type support logs the capability warning a single time, not every tick.
   */
  private warnedNoScopedPrune = false;
  /**
   * The cycle currently running, or `null` when idle. A cycle can easily outlive
   * its own interval on a large store — the bulk delete is one unbounded
   * `DELETE`, and on a store whose retention predicate is not indexable it
   * degrades to a full scan — while the timer below is fire-and-forget. Without
   * this handle the ticks STACK: the process accumulates one more concurrent
   * delete per interval, every one of them contending for the same rows, and
   * the pile never drains. Scheduled ticks are dropped while a cycle is in
   * flight; a manual {@link pruneNow} joins the in-flight cycle instead of
   * adding a second one.
   */
  private inFlight: Promise<number> | null = null;
  /**
   * Scheduled ticks dropped during the cycle that is currently in flight. Reset
   * at the end of every cycle, so it measures the CURRENT cycle's overrun, not
   * a lifetime total.
   */
  private skippedThisCycle = 0;
  /**
   * Latches while ticks are being dropped so a persistently slow store logs the
   * overlap warning once per streak rather than once per interval forever.
   * Cleared by the first cycle that completes without dropping a tick behind it.
   */
  private warnedOverlap = false;
  /**
   * Latches once after the first scope that falls back to an UNBOUNDED delete
   * because the provider has no `pruneScopedBatch`, so a legacy/third-party
   * provider says so once rather than every tick.
   */
  private warnedUnboundedDelete = false;
  /**
   * Latches while cycles keep hitting `maxBatchesPerCycle`, so a store with a
   * real backlog logs once per streak instead of once per cycle forever.
   * Cleared by the first cycle that drains every scope inside the ceiling.
   */
  private warnedBatchCeiling = false;
  /** Batch ceilings hit during the CURRENT cycle; re-arms the warning at zero. */
  private ceilingHitsThisCycle = 0;
  /** Latches while the prune lock's BACKEND is broken (not merely held). */
  private warnedLockUnavailable = false;
  /** Recent prune cycles, newest-first, capped at {@link MAX_PRUNE_RUNS}. */
  private readonly runs: PruneRun[] = [];
  /** Start time (epoch ms) of the most recent SCHEDULED cycle, for nextRunAt. */
  private lastScheduledRunAtMs: number | null = null;
  /**
   * The cross-process lock, or `null` when this deployment prunes unlocked (the
   * host set `prune.lock: false`, or supplied nothing and the provider has no
   * lease SPI). Resolved ONCE in the constructor: the host's own implementation
   * wins, else the database lease, else nothing.
   */
  private readonly lock: TelescopePruneLock | null;
  /**
   * This process's identity as a lease holder. `instanceId` is the pod name
   * under Kubernetes, which is unique per replica but NOT per process on a host
   * running two of them, so the pid is appended — two pruners must never be able
   * to mistake each other's lease for a re-entrant refresh of their own.
   */
  private readonly lockOwner: string;

  constructor(
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
  ) {
    this.lockOwner = `${config.instanceId}#${process.pid}`;
    this.lock = resolvePruneLock(config, storage);
  }

  onApplicationBootstrap(): void {
    const prune = this.config.prune;
    if (!this.config.enabled || !prune) return;
    this.timer = setInterval(() => {
      // The whole cycle is fire-and-forget on an unref'd timer: a rejection here
      // must never become an unhandled rejection or crash the host, so we always
      // catch. Individual sub-steps already swallow their own failures so one bad
      // type can't abort the rest of the cycle; this is the final backstop.
      this.runGuardedCycle(prune, 'scheduled').catch((error: unknown) => {
        this.logger.warn(`Telescope prune failed: ${asError(error).message}`);
      });
    }, prune.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Run ONE prune cycle on demand (the dashboard's "Prune now" button → the
   * controller's `retention/prune` route), recording it as a `manual` run.
   * Returns the total number of entries deleted. Throws only if `prune` is
   * unconfigured — the caller (controller) gates that and the mutation guard.
   *
   * When a cycle is already running this JOINS it (resolving with its deleted
   * count) rather than starting a competing one, so hammering the button cannot
   * pile deletes onto a store that is already struggling.
   */
  async pruneNow(): Promise<number> {
    const prune = this.config.prune;
    if (!prune) return 0;
    return this.runGuardedCycle(prune, 'manual');
  }

  /** Recent prune runs (newest-first), copied so callers can't mutate the ring. */
  getRuns(): PruneRun[] {
    return [...this.runs];
  }

  /**
   * Predicted next SCHEDULED prune time (epoch ms), or null when no `prune`
   * window is configured. Derived from the last scheduled run's start + the
   * interval, falling back to now + interval before the first cycle has run.
   */
  getNextRunAtMs(): number | null {
    const prune = this.config.prune;
    if (!prune) return null;
    return (this.lastScheduledRunAtMs ?? Date.now()) + prune.intervalMs;
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Serializes prune cycles WITHIN THIS PROCESS: at most one runs at a time.
   * A scheduled tick that lands on a busy pruner is dropped; a manual one joins
   * the cycle already running. Without this, a cycle slower than `intervalMs`
   * lets the timer queue a second, then a third, each holding write locks on
   * overlapping rows in the same store, and the backlog only grows.
   *
   * This guard sees only THIS process. Bounding the FLEET is the job of the
   * cross-process lock layered on top of it in {@link runLockedCycle}.
   */
  private runGuardedCycle(
    prune: NonNullable<ResolvedCoreConfig['prune']>,
    trigger: PruneTrigger,
  ): Promise<number> {
    const running = this.inFlight;
    if (running !== null) {
      // A manual request waits for the cycle already doing the work.
      if (trigger === 'manual') return running;
      this.skippedThisCycle += 1;
      if (!this.warnedOverlap) {
        this.warnedOverlap = true;
        this.logger.warn(
          `Telescope prune is still running when the next tick fired (interval ${prune.intervalMs}ms); dropping ticks until it finishes. Raise prune.intervalMs, widen prune.after, or index the store for the retention predicate.`,
        );
      }
      // Nothing is lost by dropping the tick: a cycle is idempotent and its
      // cutoffs are computed from `Date.now()` at start, so the next one that
      // actually runs simply deletes at a fresher cutoff.
      return Promise.resolve(0);
    }
    const cycle = this.runLockedCycle(prune, trigger).finally(() => {
      this.inFlight = null;
      // A clean cycle re-arms the warnings, so a store that degrades again later
      // says so instead of staying silent for the life of the process.
      if (this.skippedThisCycle === 0) this.warnedOverlap = false;
      if (this.ceilingHitsThisCycle === 0) this.warnedBatchCeiling = false;
      this.skippedThisCycle = 0;
      this.ceilingHitsThisCycle = 0;
    });
    this.inFlight = cycle;
    return cycle;
  }

  /**
   * Serializes prune cycles ACROSS PROCESSES, when a lock is available.
   *
   * The per-process guard above bounds one pod to one cycle; a fleet of eight
   * still put eight concurrent deletes on the same table, doing the same work
   * eight times. This takes the advisory lease first and stands down when
   * somebody else already has it.
   *
   * Three outcomes, all deliberate:
   *  - no lock configured → prune, exactly as before;
   *  - lease HELD by another replica → skip the cycle entirely and return 0. No
   *    `PruneRun` is recorded, because this pod did not prune — reporting a
   *    zero-deletion run would read as "nothing to delete", which is a different
   *    and much more alarming statement;
   *  - lock backend UNAVAILABLE (or it threw) → warn once per streak and prune
   *    ANYWAY. A broken lock must never be able to stop retention: failing open
   *    is at worst the behaviour that existed before the lock did, whereas
   *    failing closed silently lets the table grow without bound.
   */
  private async runLockedCycle(
    prune: NonNullable<ResolvedCoreConfig['prune']>,
    trigger: PruneTrigger,
  ): Promise<number> {
    const lock = this.lock;
    if (lock === null) return this.runCycle(prune, trigger);

    // The seam's contract says acquire never throws, but a host implementation
    // that breaks that promise must not take retention down with it.
    const result = await lock
      .acquire({ key: PRUNE_LOCK_KEY, owner: this.lockOwner, ttlMs: prune.lockTtlMs })
      .catch((error: unknown) => pruneLockUnavailable(asError(error).message));

    if (!result.acquired) {
      if (result.reason === 'held') {
        // The healthy path in a multi-replica deployment: most pods take this
        // branch on most ticks. Debug, never warn — it is the feature working.
        this.logger.debug(`Telescope prune skipped: ${PRUNE_LOCK_KEY} held by another instance.`);
        return 0;
      }
      if (!this.warnedLockUnavailable) {
        this.warnedLockUnavailable = true;
        const detail = result.detail === undefined ? '' : `: ${result.detail}`;
        this.logger.warn(
          `Telescope prune lock is unavailable${detail}; pruning WITHOUT cross-process exclusion until it recovers. Replicas may prune concurrently (wasteful, not unsafe).`,
        );
      }
      return this.runCycle(prune, trigger);
    }

    this.warnedLockUnavailable = false;
    try {
      return await this.runCycle(prune, trigger);
    } finally {
      // Released whether the cycle succeeded, failed, or threw. `release` is
      // contractually non-throwing, but a host that breaks that must not turn a
      // successful prune into a rejected cycle.
      await result.lease.release().catch((error: unknown) => {
        this.logger.warn(
          `Telescope prune lock release failed (the lease TTL will reclaim it): ${asError(error).message}`,
        );
      });
    }
  }

  /**
   * One prune tick, unguarded — every caller goes through
   * {@link runGuardedCycle}, so at most one of these is in flight per process.
   * The retention model is:
   *  - Each type that needs INDIVIDUAL handling — one with a `perType` override
   *    OR an archived type (which must be exported before its own delete) — is
   *    pruned in its OWN scope, at its own cutoff (its `perType` value, else the
   *    global `after`), with archiving (when configured) first.
   *  - Every OTHER type is pruned in a single bulk delete at the global cutoff,
   *    with the individually-handled types carved out.
   *
   * Archived types are ALWAYS carved out of the bulk delete even with no `perType`
   * override, so a failed sink can spare them (the bulk delete would otherwise
   * wipe entries the sink never saw). With no overrides and no archive (the common
   * case) the individual set is empty and this collapses to exactly one global
   * `prune(cutoff, keepLast)` — identical to the historical behaviour.
   */
  private async runCycle(
    prune: NonNullable<ResolvedCoreConfig['prune']>,
    trigger: PruneTrigger,
  ): Promise<number> {
    const startedAtMs = Date.now();
    const archivedTypes = this.config.archive?.types ?? new Set<string>();
    // Types needing their own scope: per-type overrides ∪ archived types.
    const individualTypes = new Set<string>([...Object.keys(prune.perTypeMs), ...archivedTypes]);

    const deletedByType: Record<string, number> = {};
    let deletedTotal = 0;
    let archivedTotal = 0;
    let error: string | undefined;

    // 1) Bulk prune for every type NOT handled individually, at the global cutoff.
    //    With an empty individual set this is a plain global prune, so legacy
    //    providers that only have `prune` behave exactly as before. The bulk
    //    delete spans many types and returns a single aggregate count, so it
    //    contributes to `deletedTotal` but is not attributed to any type key.
    const globalCutoff = new Date(startedAtMs - prune.afterMs);
    const bulk = await this.pruneArchivedThenDelete(prune, globalCutoff, prune.keepLast, {
      before: globalCutoff,
      ...(individualTypes.size > 0 ? { excludeTypes: [...individualTypes] } : {}),
      ...(prune.keepLast !== undefined ? { keepLast: prune.keepLast } : {}),
    });
    deletedTotal += bulk.deleted;
    archivedTotal += bulk.archived;
    if (bulk.error !== undefined && error === undefined) error = bulk.error;

    // 2) One scoped prune per individually-handled type, at its own cutoff (its
    //    perType override when present, else the global cutoff), archiving first.
    //    These scopes ARE type-attributable, so their counts populate
    //    `deletedByType` with real per-type numbers.
    for (const type of individualTypes) {
      const afterMs = prune.perTypeMs[type] ?? prune.afterMs;
      const cutoff = new Date(startedAtMs - afterMs);
      const step = await this.pruneArchivedThenDelete(
        prune,
        cutoff,
        prune.keepLast,
        {
          before: cutoff,
          type,
          ...(prune.keepLast !== undefined ? { keepLast: prune.keepLast } : {}),
        },
        type,
      );
      if (step.deleted > 0) deletedByType[type] = (deletedByType[type] ?? 0) + step.deleted;
      deletedTotal += step.deleted;
      archivedTotal += step.archived;
      if (step.error !== undefined && error === undefined) error = step.error;
    }

    if (trigger === 'scheduled') this.lastScheduledRunAtMs = startedAtMs;
    this.recordRun({
      at: new Date(startedAtMs).toISOString(),
      trigger,
      durationMs: Date.now() - startedAtMs,
      deletedTotal,
      deletedByType,
      ...(archivedTotal > 0 ? { archivedTotal } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    return deletedTotal;
  }

  /**
   * Append a run to the newest-first ring buffer, evicting the oldest past the
   * cap. Recording must NEVER throw into the prune path (a bad ISO/serialization
   * would otherwise turn observability into an outage), so it is fully guarded.
   */
  private recordRun(run: PruneRun): void {
    try {
      this.runs.unshift(run);
      while (this.runs.length > MAX_PRUNE_RUNS) this.runs.pop();
    } catch (error: unknown) {
      this.logger.warn(`Telescope failed to record prune run: ${asError(error).message}`);
    }
  }

  /**
   * Archives (if configured) the entries this `scope` is about to delete, then
   * deletes them. When the scope targets a single archived `type` whose sink
   * fails, the delete is SKIPPED (entries survive to retry next cycle) but the
   * caller's other scopes are unaffected. Errors never propagate out of here.
   *
   * `fallbackOlderThan`/`fallbackKeepLast` are used only by the legacy global
   * fallback path when the provider lacks `pruneScoped`.
   */
  private async pruneArchivedThenDelete(
    prune: NonNullable<ResolvedCoreConfig['prune']>,
    fallbackOlderThan: Date,
    fallbackKeepLast: number | undefined,
    scope: PruneScope,
    archivableType?: string,
  ): Promise<PruneStepResult> {
    try {
      // Archive must complete before the matching delete. If it throws for a
      // single-type scope, bail WITHOUT deleting so the data survives.
      const { proceed, archived } = await this.archiveScope(scope, archivableType);
      if (!proceed) return { deleted: 0, archived };
      const deleted = await this.deleteScope(prune, scope, fallbackOlderThan, fallbackKeepLast);
      return { deleted, archived };
    } catch (error: unknown) {
      const message = asError(error).message;
      this.logger.warn(`Telescope prune step failed: ${message}`);
      return { deleted: 0, archived: 0, error: message };
    }
  }

  /**
   * Exports the doomed entries for an archived single-type scope to the sink in
   * bounded batches. `proceed` is `true` when it is safe to delete (nothing to
   * archive, archiving succeeded, or this type/scope is not archived) and
   * `false` when the sink failed (skip the delete this cycle); `archived` is the
   * number of entries actually handed to the sink.
   */
  private async archiveScope(
    scope: PruneScope,
    archivableType?: string,
  ): Promise<{ proceed: boolean; archived: number }> {
    const archive = this.config.archive;
    // Only single-type scopes that are in the archive set are exported. The
    // global bulk scope (excludeTypes) is never archived: archived types always
    // get their own per-type scope, so they are never part of the bulk delete.
    if (
      archive === undefined ||
      archivableType === undefined ||
      !archive.types.has(archivableType)
    ) {
      return { proceed: true, archived: 0 };
    }

    let archived = 0;
    try {
      let batchesDone = 0;
      let cursor: string | undefined;
      while (batchesDone < archive.maxBatchesPerCycle) {
        const page = await this.storage.get({
          type: archivableType,
          before: scope.before,
          limit: archive.batchSize,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (page.data.length === 0) break;
        await archive.sink(page.data);
        archived += page.data.length;
        batchesDone += 1;
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
        if (batchesDone === archive.maxBatchesPerCycle && page.nextCursor !== null) {
          // Backlog exceeds this cycle's cap. Stop here; the remainder is
          // archived next tick. We deliberately do NOT delete this type now,
          // because the unarchived remainder is exactly what we must keep — the
          // delete cutoff would otherwise wipe entries the sink never saw.
          this.logger.warn(
            `Telescope archive for type "${archivableType}" hit the per-cycle batch cap ` +
              `(${archive.maxBatchesPerCycle}); remaining entries deferred to next cycle.`,
          );
          return { proceed: false, archived };
        }
      }
      return { proceed: true, archived };
    } catch (error: unknown) {
      // Rate-limited to once per cycle (this method runs once per archived type
      // per cycle). Skip the delete so the doomed entries survive for a retry.
      this.logger.warn(
        `Telescope archive sink failed for type "${archivableType}"; ` +
          `skipping its prune this cycle: ${asError(error).message}`,
      );
      return { proceed: false, archived };
    }
  }

  /**
   * Deletes the scope, preferring BOUNDED BATCHES.
   *
   * Order of preference:
   *  1. `pruneScopedBatch` — a loop of short, individually-committed deletes.
   *     This is the whole point: the unbounded form is a single statement that,
   *     on a large table, holds row locks for as long as it takes to scan the
   *     table, and every other writer on that database waits behind it. Batching
   *     deletes the same rows while giving the locks up between batches.
   *  2. `pruneScoped` — one unbounded delete, per-type-aware.
   *  3. the legacy global `prune` — the global cutoff for ALL types, the best a
   *     provider without per-type support can do. Run only for the global scope,
   *     to avoid deleting more than intended on a per-type scope.
   *
   * A `keepLast` scope always takes the unbounded path: "keep the newest N of
   * the doomed rows" is a whole-set property that a bounded batch cannot express
   * (hence `keepLast` is absent from {@link BoundedPruneScope}). `keepLast` is
   * off by default, so the common configuration batches.
   */
  private async deleteScope(
    prune: NonNullable<ResolvedCoreConfig['prune']>,
    scope: PruneScope,
    fallbackOlderThan: Date,
    fallbackKeepLast: number | undefined,
  ): Promise<number> {
    const pruneScopedBatch = this.storage.pruneScopedBatch;
    if (pruneScopedBatch !== undefined && scope.keepLast === undefined) {
      return this.deleteScopeInBatches(prune, scope);
    }
    if (this.storage.pruneScoped !== undefined) {
      if (pruneScopedBatch === undefined && !this.warnedUnboundedDelete) {
        this.warnedUnboundedDelete = true;
        this.logger.warn(
          'Storage provider does not implement pruneScopedBatch(); prune deletes are ' +
            'UNBOUNDED. On a large store one such delete can hold row locks for minutes ' +
            'and block every other writer.',
        );
      }
      return this.storage.pruneScoped(scope);
    }
    if (!this.warnedNoScopedPrune) {
      this.warnedNoScopedPrune = true;
      this.logger.warn(
        'Storage provider does not implement pruneScoped(); per-type retention ' +
          'is unavailable. Falling back to the global prune cutoff for all types.',
      );
    }
    // Run the legacy global prune ONLY for the global (non-type) scope, so the
    // fallback prunes the whole store once at the global cutoff rather than
    // re-running per overridden type (which the global prune can't scope).
    if (scope.type === undefined) {
      return this.storage.prune(fallbackOlderThan, fallbackKeepLast);
    }
    return 0;
  }

  /**
   * Drains one scope in bounded deletes: at most `batchSize` rows per statement,
   * at most `maxBatchesPerCycle` statements, pausing `batchPauseMs` between
   * them, stopping as soon as the provider says the scope is drained.
   *
   * The ceiling is not a nicety. Without it, a table far enough behind turns one
   * tick into an unbounded loop — the same "one prune runs for an hour" failure
   * this replaces, only now spelled as a thousand statements instead of one. With
   * it, every cycle has a known worst case and a backlog drains over several
   * cycles instead of monopolising one.
   *
   * The pause is only ever paid BETWEEN batches, so the healthy case — one batch,
   * `hasMore: false` — never waits at all. It exists for the unhealthy case,
   * where a tight delete loop can starve co-tenants of a small instance's IOPS
   * budget even though no individual statement holds locks for long.
   */
  private async deleteScopeInBatches(
    prune: NonNullable<ResolvedCoreConfig['prune']>,
    scope: PruneScope,
  ): Promise<number> {
    // Rebuilt field-by-field rather than spread: `keepLast` must not reach a
    // bounded scope (it is not in the type, and a spread of a wider object would
    // smuggle it through at runtime), and `exactOptionalPropertyTypes` forbids
    // writing `type: undefined`.
    const bounded: BoundedPruneScope = {
      before: scope.before,
      limit: prune.batchSize,
      ...(scope.type !== undefined ? { type: scope.type } : {}),
      ...(scope.excludeTypes !== undefined ? { excludeTypes: scope.excludeTypes } : {}),
    };
    let deletedTotal = 0;
    for (let batch = 0; batch < prune.maxBatchesPerCycle; batch += 1) {
      if (batch > 0 && prune.batchPauseMs > 0) await sleep(prune.batchPauseMs);
      // Called off `this.storage` so a provider implemented with `this` keeps it.
      const result = await this.storage.pruneScopedBatch?.(bounded);
      // Cannot happen — `deleteScope` checked the method exists — but reading it
      // back off the provider means TypeScript wants the guard, and a provider
      // that mutates its own methods at runtime gets a clean exit instead of a
      // TypeError inside the retention path.
      if (result === undefined) return deletedTotal;
      deletedTotal += result.deleted;
      if (!result.hasMore) return deletedTotal;
    }
    this.ceilingHitsThisCycle += 1;
    if (!this.warnedBatchCeiling) {
      this.warnedBatchCeiling = true;
      this.logger.warn(
        `Telescope prune hit its per-cycle batch ceiling (${prune.maxBatchesPerCycle} × ${prune.batchSize} rows); entries older than the retention window remain and will be deleted over the next cycles. Raise prune.maxBatchesPerCycle or prune.batchSize, or shorten prune.intervalMs, if the backlog is not shrinking.`,
      );
    }
    return deletedTotal;
  }
}

/**
 * Picks the cross-process lock for this deployment, once, at construction:
 * the host's own implementation if it supplied one, else a lease in the store
 * Telescope is already writing to, else nothing (prune unlocked, as before).
 */
function resolvePruneLock(
  config: ResolvedCoreConfig,
  storage: StorageProvider,
): TelescopePruneLock | null {
  const prune = config.prune;
  if (prune === undefined || !prune.lockEnabled) return null;
  if (prune.lock !== undefined) return prune.lock;
  if (isLeaseCapableStorage(storage)) return new StorageLeasePruneLock(storage);
  return null;
}

/** Unref'd so a pending inter-batch pause can never hold a shutting-down process open. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
