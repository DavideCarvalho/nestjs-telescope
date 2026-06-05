// packages/core/src/ai/diagnosis-coordinator.ts
import { Logger } from '@nestjs/common';
import { NewExceptionTracker } from '../alerts/new-exception-tracker.js';
import { durationToMs } from '../config/parse-duration.js';
import { type Entry, EntryType } from '../entry/entry.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { buildDiagnoseContext } from './diagnose-context-builder.js';
import type { ExceptionDiagnoser, TelescopeAiOptions } from './diagnoser.js';
import { DiagnosisCache } from './diagnosis-cache.js';

/**
 * Window for auto-mode's "is this a NEW family?" dedup. Mirrors the default
 * `new-exception` alert window so an exception that auto-diagnosed once doesn't
 * re-diagnose on every later occurrence within the same window (the cache also
 * guards this, but the tracker stops us even ENQUEUEING a redundant diagnosis).
 */
const AUTO_NEW_FAMILY_WINDOW = '1h';

/**
 * Default grace an alert waits for an in-flight auto-mode diagnosis before
 * dispatching WITHOUT it. Kept short: the alert is the time-critical artifact, so
 * we'd rather page promptly with no AI note than hold the page waiting on a model.
 */
const DEFAULT_ALERT_GRACE_MS = 10_000;

/** Outcome of a diagnose request: the markdown plus whether it was a cache hit. */
export interface DiagnoseResult {
  markdown: string;
  cached: boolean;
}

/**
 * Central AI-diagnosis coordinator. Owns the diagnoser, the per-family cache, and
 * the auto-mode wiring. Constructed only when the host configures `ai`; the
 * service injects nothing AI-related otherwise, so the feature is zero-cost off.
 *
 * Two entry points:
 *  - {@link diagnose}: on-demand, behind the dashboard endpoint. Cache-first
 *    (unless `force`), and a diagnoser rejection PROPAGATES so the controller can
 *    map it to a safe 5xx.
 *  - {@link onNewFamily}: auto-mode. Called from the alerter's first-seen signal.
 *    Fire-and-forget — it NEVER throws into the flush path; a failure is swallowed
 *    and logged. The in-flight promise is tracked so an alert firing for the same
 *    family can briefly await it ({@link awaitForAlert}) and attach the result.
 */
export class DiagnosisCoordinator {
  private readonly logger: Logger;
  private readonly diagnoser: ExceptionDiagnoser;
  readonly mode: 'auto' | 'on-demand';
  private readonly cache: DiagnosisCache;
  /** In-flight auto-mode diagnoses keyed by familyHash (so alerts can await). */
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly alertGraceMs: number;
  /** First-seen tracker backing auto-mode (independent of the alerter's). */
  private readonly newFamilyTracker: NewExceptionTracker;
  private readonly newFamilyWindowMs: number;
  private readonly now: () => number;

  constructor(
    options: TelescopeAiOptions,
    private readonly storage: StorageProvider,
    deps?: { cache?: DiagnosisCache; logger?: Logger; alertGraceMs?: number; now?: () => number },
  ) {
    this.diagnoser = options.diagnoser;
    this.mode = options.mode ?? 'on-demand';
    this.cache = deps?.cache ?? new DiagnosisCache();
    this.logger = deps?.logger ?? new Logger(DiagnosisCoordinator.name);
    this.alertGraceMs = deps?.alertGraceMs ?? DEFAULT_ALERT_GRACE_MS;
    this.now = deps?.now ?? Date.now;
    this.newFamilyTracker = new NewExceptionTracker();
    this.newFamilyWindowMs = durationToMs(AUTO_NEW_FAMILY_WINDOW);
  }

  /**
   * Auto-mode flush hook, wired into the Recorder's `onFlushStored` path (the
   * SAME path the new-exception alert evaluates on). For each just-stored
   * exception, do a cheap first-seen check; on a genuinely NEW family kick off a
   * fire-and-forget diagnosis. Independent of whether a `new-exception` ALERT
   * rule is configured — auto-diagnosis is its own feature. No-op in on-demand
   * mode. NEVER throws into the flush path.
   */
  observeFlush(storedEntries: Entry[]): void {
    if (!this.isAuto) return;
    const nowMs = this.now();
    for (const entry of storedEntries) {
      if (entry.type !== EntryType.Exception && entry.type !== EntryType.ClientException) {
        continue;
      }
      if (entry.familyHash === null) continue;
      const isNew = this.newFamilyTracker.observe(entry.familyHash, nowMs, this.newFamilyWindowMs);
      if (!isNew) continue;
      // Occurrence count is 1 at first-seen by definition; the on-demand path
      // recomputes a precise count, but auto-mode triggers exactly here.
      void this.onNewFamily(entry, 1);
    }
  }

  /**
   * On-demand diagnosis for an exception entry. Serves from cache unless `force`.
   * A diagnoser rejection propagates to the caller (the endpoint turns it into a
   * safe 502). On success the result is cached by family for the next reader.
   *
   * @throws whatever the diagnoser rejects with (timeout/model error).
   */
  async diagnose(entry: Entry, occurrenceCount: number, force = false): Promise<DiagnoseResult> {
    const familyHash = entry.familyHash;
    if (!force && familyHash !== null) {
      const cached = this.cache.get(familyHash);
      if (cached !== null) return { markdown: cached, cached: true };
    }
    const context = await buildDiagnoseContext(this.storage, entry, occurrenceCount);
    const markdown = await this.diagnoser.diagnose(context);
    if (familyHash !== null) this.cache.set(familyHash, markdown);
    return { markdown, cached: false };
  }

  /**
   * Read-only, cache-ONLY lookup for an entry's diagnosis. Returns the cached
   * markdown for the entry's family, or `null` on a miss / when the entry has no
   * family hash. NEVER builds context and NEVER calls the diagnoser — so it costs
   * nothing and can be safely fetched on every detail-page open. This is what
   * makes an auto-mode (or previously on-demand) diagnosis visible immediately:
   * the cache was populated by `observeFlush`/`onNewFamily` (auto) or a prior
   * `diagnose` (on-demand), and this just surfaces it without re-running.
   */
  peekCached(entry: Entry): string | null {
    const familyHash = entry.familyHash;
    if (familyHash === null) return null;
    return this.cache.get(familyHash);
  }

  /**
   * Auto-mode hook: a NEW exception family was just seen. Kick off diagnosis
   * fire-and-forget and cache the result. NEVER throws — this runs inside the
   * flush/alert path. If a diagnosis for this family is already in flight or
   * already cached, do nothing (at most once per family per cache window).
   *
   * Returns the tracked promise (resolving to the markdown, or `null` on
   * failure) so the alert path can await it; callers on the flush path ignore it.
   */
  onNewFamily(entry: Entry, occurrenceCount: number): Promise<string | null> {
    const familyHash = entry.familyHash;
    if (familyHash === null) return Promise.resolve(null);
    if (this.cache.has(familyHash)) return Promise.resolve(this.cache.get(familyHash));
    const existing = this.inFlight.get(familyHash);
    if (existing !== undefined) return existing;

    const task = this.runDiagnosis(entry, occurrenceCount, familyHash);
    this.inFlight.set(familyHash, task);
    return task;
  }

  /**
   * Briefly await an in-flight (or cached) diagnosis for `familyHash`, for the
   * alert path to attach it. Returns the markdown if ready within the grace cap,
   * else `null` (the alert dispatches without it). Never throws.
   */
  async awaitForAlert(familyHash: string, graceMs = this.alertGraceMs): Promise<string | null> {
    const cached = this.cache.get(familyHash);
    if (cached !== null) return cached;
    const pending = this.inFlight.get(familyHash);
    if (pending === undefined) return null;
    // Race the in-flight diagnosis against a short timer; whichever wins, the
    // alert proceeds. A timeout here does NOT cancel the diagnosis — it keeps
    // running and lands in the cache for the next reader.
    return Promise.race([
      pending.catch(() => null),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), graceMs);
        timer.unref?.();
      }),
    ]);
  }

  /** True when running in `'auto'` mode (the alerter wires the first-seen hook). */
  get isAuto(): boolean {
    return this.mode === 'auto';
  }

  /** Run + cache one diagnosis, swallowing every failure. Clears the in-flight slot. */
  private async runDiagnosis(
    entry: Entry,
    occurrenceCount: number,
    familyHash: string,
  ): Promise<string | null> {
    try {
      const context = await buildDiagnoseContext(this.storage, entry, occurrenceCount);
      const markdown = await this.diagnoser.diagnose(context);
      this.cache.set(familyHash, markdown);
      return markdown;
    } catch (error: unknown) {
      // Auto-mode must never break flush/alerting — log once and move on.
      this.logger.warn(
        `Telescope AI auto-diagnosis failed for family ${familyHash}: ${(error as Error).message}`,
      );
      return null;
    } finally {
      this.inFlight.delete(familyHash);
    }
  }
}

export { DEFAULT_ALERT_GRACE_MS };
