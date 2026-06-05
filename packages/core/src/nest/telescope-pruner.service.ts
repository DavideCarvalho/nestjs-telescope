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
      this.runCycle(prune).catch((error: unknown) => {
        this.logger.warn(`Telescope prune failed: ${asError(error).message}`);
      });
    }, prune.intervalMs);
    this.timer.unref?.();
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
  private async runCycle(prune: NonNullable<ResolvedCoreConfig['prune']>): Promise<void> {
    const now = Date.now();
    const archivedTypes = this.config.archive?.types ?? new Set<string>();
    // Types needing their own scope: per-type overrides ∪ archived types.
    const individualTypes = new Set<string>([...Object.keys(prune.perTypeMs), ...archivedTypes]);

    // 1) Bulk prune for every type NOT handled individually, at the global cutoff.
    //    With an empty individual set this is a plain global prune, so legacy
    //    providers that only have `prune` behave exactly as before.
    const globalCutoff = new Date(now - prune.afterMs);
    await this.pruneArchivedThenDelete(globalCutoff, prune.keepLast, {
      before: globalCutoff,
      ...(individualTypes.size > 0 ? { excludeTypes: [...individualTypes] } : {}),
      ...(prune.keepLast !== undefined ? { keepLast: prune.keepLast } : {}),
    });

    // 2) One scoped prune per individually-handled type, at its own cutoff (its
    //    perType override when present, else the global cutoff), archiving first.
    for (const type of individualTypes) {
      const afterMs = prune.perTypeMs[type] ?? prune.afterMs;
      const cutoff = new Date(now - afterMs);
      await this.pruneArchivedThenDelete(
        cutoff,
        prune.keepLast,
        {
          before: cutoff,
          type,
          ...(prune.keepLast !== undefined ? { keepLast: prune.keepLast } : {}),
        },
        type,
      );
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
  ): Promise<void> {
    try {
      // Archive must complete before the matching delete. If it throws for a
      // single-type scope, bail WITHOUT deleting so the data survives.
      const archived = await this.archiveScope(scope, archivableType);
      if (!archived) return;
      await this.deleteScope(scope, fallbackOlderThan, fallbackKeepLast);
    } catch (error: unknown) {
      this.logger.warn(`Telescope prune step failed: ${asError(error).message}`);
    }
  }

  /**
   * Exports the doomed entries for an archived single-type scope to the sink in
   * bounded batches. Returns `true` when it is safe to proceed with the delete
   * (nothing to archive, archiving succeeded, or this type/scope is not
   * archived) and `false` when the sink failed (skip the delete this cycle).
   */
  private async archiveScope(scope: PruneScope, archivableType?: string): Promise<boolean> {
    const archive = this.config.archive;
    // Only single-type scopes that are in the archive set are exported. The
    // global bulk scope (excludeTypes) is never archived: archived types always
    // get their own per-type scope, so they are never part of the bulk delete.
    if (
      archive === undefined ||
      archivableType === undefined ||
      !archive.types.has(archivableType)
    ) {
      return true;
    }

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
          return false;
        }
      }
      return true;
    } catch (error: unknown) {
      // Rate-limited to once per cycle (this method runs once per archived type
      // per cycle). Skip the delete so the doomed entries survive for a retry.
      this.logger.warn(
        `Telescope archive sink failed for type "${archivableType}"; ` +
          `skipping its prune this cycle: ${asError(error).message}`,
      );
      return false;
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
  ): Promise<void> {
    if (this.storage.pruneScoped !== undefined) {
      await this.storage.pruneScoped(scope);
      return;
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
      await this.storage.prune(fallbackOlderThan, fallbackKeepLast);
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
