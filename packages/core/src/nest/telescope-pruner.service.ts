// packages/core/src/nest/telescope-pruner.service.ts
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { PruneScope, StorageProvider } from '../storage/storage-provider.js';
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
  /** Recent prune cycles, newest-first, capped at {@link MAX_PRUNE_RUNS}. */
  private readonly runs: PruneRun[] = [];
  /** Start time (epoch ms) of the most recent SCHEDULED cycle, for nextRunAt. */
  private lastScheduledRunAtMs: number | null = null;

  constructor(
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
  ) {}

  onApplicationBootstrap(): void {
    const prune = this.config.prune;
    if (!this.config.enabled || !prune) return;
    this.timer = setInterval(() => {
      // The whole cycle is fire-and-forget on an unref'd timer: a rejection here
      // must never become an unhandled rejection or crash the host, so we always
      // catch. Individual sub-steps already swallow their own failures so one bad
      // type can't abort the rest of the cycle; this is the final backstop.
      this.runCycle(prune, 'scheduled').catch((error: unknown) => {
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
   */
  async pruneNow(): Promise<number> {
    const prune = this.config.prune;
    if (!prune) return 0;
    return this.runCycle(prune, 'manual');
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
   * One prune tick. The retention model is:
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
    const bulk = await this.pruneArchivedThenDelete(globalCutoff, prune.keepLast, {
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
      const deleted = await this.deleteScope(scope, fallbackOlderThan, fallbackKeepLast);
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
   * Deletes the scope via the provider's `pruneScoped` when available, else
   * falls back ONCE (with a logged warning) to the legacy global `prune` — which
   * uses the global cutoff for ALL types, the best a provider without per-type
   * support can do. The fallback runs only for the global scope to avoid
   * deleting more than intended on a per-type scope.
   */
  private async deleteScope(
    scope: PruneScope,
    fallbackOlderThan: Date,
    fallbackKeepLast: number | undefined,
  ): Promise<number> {
    if (this.storage.pruneScoped !== undefined) {
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
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
