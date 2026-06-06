// packages/core/src/nest/telescope.service.ts
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { v7 } from 'uuid';
import { DiagnosisCoordinator } from '../ai/diagnosis-coordinator.js';
import { resolveAlerts } from '../alerts/resolve-alerts.js';
import { TelescopeAlerter } from '../alerts/telescope-alerter.js';
import type { AuthMode, ResolvedDashboardAuth } from '../auth/dashboard-auth-config.js';
import type { ResolvedCoreConfig } from '../config/options.js';
import { samplingRates } from '../config/sampling.js';
import { createBatch } from '../context/batch.js';
import { TelescopeContext } from '../context/telescope-context.js';
import { setTelescopeDump } from '../dump/telescope-dump.js';
import { type BatchOrigin, EntryType, type RecordInput } from '../entry/entry.js';
import { Recorder, type RecorderSelfMetrics } from '../recorder/recorder.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_DASHBOARD_AUTH,
  TELESCOPE_OPTIONS,
  TELESCOPE_STORAGE,
  type TelescopeModuleOptions,
} from './telescope.options.js';
import type { BatchHandle } from './watcher.js';

export interface TelescopeMeta {
  enabled: boolean;
  droppedCount: number;
  watchers: string[];
  traceLink: string | null;
  /**
   * Whether the host wired a `traceContext` provider. When `false`, every entry's
   * `trace_id` is null, so the dashboard's Traces page is permanently empty — the
   * UI hides that nav item, mirroring how unregistered watchers hide their types.
   */
  tracesEnabled: boolean;
  /** Resolved retention window from `prune`, or `null` when unbounded. */
  retention: { afterMs: number; keepLast: number | null } | null;
  /**
   * Whether on-demand pruning is available from the dashboard: requires both a
   * configured retention window (`prune`) AND mutations enabled (`authorizeAction`
   * present, the same default-deny gate the queue mutations use). When `false`,
   * the dashboard hides/disables the "Prune now" control.
   */
  pruneEnabled: boolean;
  /**
   * Whether the query EXPLAIN feature is available (the host configured an
   * `explainQuery` hook). When `false`, the dashboard hides the "Explain" button.
   */
  explainEnabled: boolean;
  /** Resolved per-type sample rates (0..1). Empty when no sampling configured. */
  sampling: Record<string, number>;
  /**
   * Dashboard cookie-auth state for the AUTHENTICATED UI (e.g. showing a logout
   * button + the active modes). The UNauthenticated SPA learns the modes from
   * the 401 body of `GET /api/auth/me` instead — meta stays behind the gate.
   */
  auth: { enabled: boolean; modes: AuthMode[] };
  /**
   * Webhook alerting state: whether `alerts` is configured and how many rules
   * are armed. The dashboard surfaces this as a read-only "Alerts: N rules" badge.
   */
  alerts: { enabled: boolean; ruleCount: number };
  /**
   * AI exception-diagnosis state. `enabled` is true when the host configured a
   * `diagnoser`; the dashboard renders the "Diagnose with AI" button on exception
   * detail pages only then. `mode` mirrors the configured mode (`'on-demand'` by
   * default), purely informational for the UI.
   */
  ai: { enabled: boolean; mode: 'auto' | 'on-demand' | null };
}

/**
 * Self-observability snapshot for surfacing Telescope's OWN overhead. Combines
 * the Recorder's cheap self-metrics with whether capture is enabled and an
 * on-demand micro-benchmark of the per-capture cost (never measured on the live
 * `record()` path).
 */
export interface TelescopeHealth extends RecorderSelfMetrics {
  /** Whether capture is currently enabled (from config). */
  enabled: boolean;
  /** Mean nanoseconds per capture, from an on-demand micro-benchmark. */
  captureCostNanos: number;
}

/** Iterations used by the on-demand capture-cost micro-benchmark. */
const CAPTURE_COST_BENCHMARK_ITERATIONS = 1000;

@Injectable()
export class TelescopeService implements OnModuleInit, OnApplicationShutdown {
  readonly context = new TelescopeContext();
  private readonly recorder: Recorder;
  private readonly logger = new Logger(TelescopeService.name);
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private watcherTypes: string[] = [];
  /** Resolved (boot-validated) alerting config, or `null` when unconfigured. */
  private readonly alerts: ReturnType<typeof resolveAlerts>;
  private alerter: TelescopeAlerter | null = null;
  /** AI exception-diagnosis coordinator, or `null` when `ai` is unconfigured. */
  private readonly diagnosis: DiagnosisCoordinator | null;

  constructor(
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_DASHBOARD_AUTH)
    private readonly dashboardAuth: ResolvedDashboardAuth | null = null,
  ) {
    // Boot-validate alerts FIRST (fail-closed at provider instantiation, like
    // dashboardAuth): no destination / empty rules / bad duration throws.
    this.alerts = resolveAlerts(this.options.alerts);
    // Build the AI coordinator (if configured) BEFORE the Recorder so its
    // auto-mode flush hook can be wired into `onFlushStored` below. The
    // coordinator is a no-op on the flush path in on-demand mode.
    this.diagnosis =
      this.options.ai !== undefined
        ? new DiagnosisCoordinator(this.options.ai, this.storage)
        : null;
    this.recorder = new Recorder({
      storage,
      context: this.context,
      instanceId: config.instanceId,
      taggers: config.taggers,
      redact: config.redact,
      sampling: config.sampling,
      bufferSize: config.recorder.bufferSize,
      retryDelayMs: config.recorder.retryDelayMs,
      idFactory: () => v7(),
      ...(config.filter ? { filter: config.filter } : {}),
      ...(config.traceContext ? { traceContext: config.traceContext } : {}),
      // Per-flush new-exception evaluation: cheap map lookup per stored exception,
      // batch-context fetch only on a real fire. Delegates to the alerter built
      // just below; the closure reads `this.alerter` at flush time (always set by
      // then). Never throws into the flush — the alerter swallows failures.
      // The same path drives AI auto-mode: a NEW family kicks off a fire-and-
      // forget diagnosis (no-op in on-demand mode / when AI is off).
      onFlushStored: (entries) => {
        this.diagnosis?.observeFlush(entries);
        return this.alerter?.evaluateFlush(entries);
      },
    });
    // Construct the alerter AFTER the Recorder so its `droppedCount` baseline can
    // be read. The interval is started later in onModuleInit; the new-exception
    // hook above is already wired and becomes live as soon as this is assigned.
    if (this.alerts !== null) {
      this.alerter = new TelescopeAlerter({
        alerts: this.alerts,
        storage: this.storage,
        instanceId: this.config.instanceId,
        droppedCount: () => this.recorder.droppedCount,
        // In auto-mode, let a firing new-exception alert briefly await the AI
        // diagnosis and attach it. on-demand / off → no hook, no enrichment.
        ...(this.diagnosis?.isAuto
          ? {
              diagnosisFor: (familyHash: string) =>
                this.diagnosis?.awaitForAlert(familyHash) ?? Promise.resolve(null),
            }
          : {}),
      });
    }
    // Wire the global dump sink so `telescopeDump(value, label)` can be called
    // anywhere without injecting this service. Cleared on shutdown.
    setTelescopeDump((value, label) => this.dump(value, label));
  }

  /**
   * Record a developer debug dump into the Dumps tab. The value is redacted by
   * the Recorder and correlated to the active batch automatically. Prefer the
   * free `telescopeDump()` at call sites that don't already inject this service.
   */
  dump(value: unknown, label?: string): void {
    this.record({ type: EntryType.Dump, content: { label: label ?? null, value } });
  }

  /** Normalized mount segment (no leading/trailing slash). Default `'telescope'`. */
  get path(): string {
    return this.config.path;
  }

  /**
   * Host-supplied hook to resolve the authenticated user from a raw request
   * (used by the request middleware). `undefined` when the host didn't supply
   * one — the middleware then falls back to reading `request.user`.
   */
  get resolveUser(): ((request: unknown) => unknown) | undefined {
    return this.options.resolveUser;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) return;
    // Retention guardrail: without `prune`, the entry table grows unbounded and
    // the windowed analytics scans (pulse/timeseries/stats) get slower over time.
    // Warn once at boot so hosts opt into a retention window (and/or `sampling`
    // for noisy request floods) rather than discovering the slowdown in prod.
    if (this.config.prune === undefined) {
      this.logger.warn(
        'No `prune` configured — Telescope entries accumulate without bound, ' +
          'slowing analytics over time. Set e.g. `prune: { after: "1h" }` ' +
          '(and/or `sampling` to down-sample noisy request volume).',
      );
    } else if (Object.keys(this.config.sampling).length === 0) {
      // Retention is set, but with no `sampling` every captured entry is kept —
      // the retained working set is `prune.after × ingest rate × entry size`.
      // High-volume streams (cache hits especially) dominate that product, so
      // nudge hosts toward per-type sampling. INFO, single line, non-noisy.
      this.logger.log(
        'No `sampling` configured — high-volume streams (e.g. cache) are kept in full. ' +
          'Add per-type rates to bound store volume, e.g. `sampling: { cache: 0.1 }`.',
      );
    }
    // Let the storage acquire resources / ensure its schema before first use.
    await this.storage.init?.();
    this.flushTimer = setInterval(() => {
      this.recorder.flush().catch((error: unknown) => {
        this.logger.warn(`Telescope flush failed: ${(error as Error).message}`);
      });
    }, this.config.recorder.flushIntervalMs);
    // Don't keep the event loop alive solely for the flush timer.
    this.flushTimer.unref?.();
    // Start alerting when configured (unref'd interval for the rate rules; the
    // new-exception rule already runs via the Recorder's onFlushStored hook).
    // Never crashes the host — failures are swallowed inside the alerter.
    this.alerter?.start();
  }

  async onApplicationShutdown(): Promise<void> {
    // Detach the global dump sink so stray post-shutdown calls become no-ops.
    setTelescopeDump(null);
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.alerter) {
      this.alerter.stop();
      this.alerter = null;
    }
    await this.recorder.flush();
    // Always close after the final flush. Providers that borrow a host resource no-op close().
    await this.storage.close?.();
  }

  /** Register the set of active watcher type names (for meta). */
  /** @internal Used by TelescopeWatcherRegistrar; not part of the public API. */
  setWatchers(types: string[]): void {
    this.watcherTypes = types;
  }

  record(input: RecordInput): void {
    if (!this.config.enabled) return;
    this.recorder.record(input);
  }

  runInBatch<T>(origin: BatchOrigin, fn: () => Promise<T>): Promise<T> {
    // When disabled, do zero work — no batch, no ALS context.
    if (!this.config.enabled) return fn();
    const batch = createBatch(origin, () => v7());
    return this.context.run(batch, fn);
  }

  /**
   * Open a batch and make it active for the current async execution (no
   * callback scope). Returns a handle; `end()` is a no-op today (the async
   * scope ends naturally) but is part of the contract for future cleanup.
   */
  beginBatch(origin: BatchOrigin): BatchHandle {
    const batch = createBatch(origin, () => v7());
    if (this.config.enabled) {
      this.context.enterWith(batch);
    }
    return { id: batch.id, end: () => {} };
  }

  async flush(): Promise<void> {
    await this.recorder.flush();
  }

  /**
   * Pause capture (overload protection). While paused the Recorder drops new
   * `record()` calls; flushing continues so the buffer drains. Driven by the
   * OverloadGuard when event-loop lag crosses its threshold.
   */
  pause(): void {
    this.recorder.pause();
  }

  /** Resume capture after a {@link pause}. */
  resume(): void {
    this.recorder.resume();
  }

  /** Whether capture is currently paused by overload protection. */
  get isPaused(): boolean {
    return this.recorder.isPaused;
  }

  async getMeta(): Promise<TelescopeMeta> {
    return {
      enabled: this.config.enabled,
      droppedCount: this.recorder.droppedCount,
      watchers: [...this.watcherTypes],
      traceLink: this.config.traceLink ?? null,
      tracesEnabled: this.config.traceContext !== undefined,
      retention: this.config.prune
        ? {
            afterMs: this.config.prune.afterMs,
            keepLast: this.config.prune.keepLast ?? null,
          }
        : null,
      pruneEnabled: this.config.prune !== undefined && Boolean(this.options.authorizeAction),
      explainEnabled: Boolean(this.options.explainQuery),
      sampling: samplingRates(this.config.sampling),
      auth: {
        enabled: this.dashboardAuth !== null,
        modes: this.dashboardAuth ? [...this.dashboardAuth.modes] : [],
      },
      alerts: {
        enabled: this.alerts !== null,
        ruleCount: this.alerts?.rules.length ?? 0,
      },
      ai: {
        enabled: this.diagnosis !== null,
        mode: this.diagnosis?.mode ?? null,
      },
    };
  }

  /**
   * AI exception-diagnosis coordinator, or `null` when `ai` is unconfigured. The
   * gated controller reads this to run the on-demand `diagnose` endpoint (and to
   * 404 when AI is off).
   */
  get diagnosisCoordinator(): DiagnosisCoordinator | null {
    return this.diagnosis;
  }

  /**
   * Self-observability snapshot: the Recorder's cheap self-metrics plus an
   * on-demand micro-benchmark of the per-capture cost. The benchmark runs the
   * synchronous enrich path on a representative input WITHOUT enqueuing, so it
   * never pollutes the live buffer or taxes real records.
   */
  getHealth(): TelescopeHealth {
    return {
      ...this.recorder.getSelfMetrics(),
      enabled: this.config.enabled,
      captureCostNanos: this.recorder.benchmarkRecordCost(CAPTURE_COST_BENCHMARK_ITERATIONS),
    };
  }
}
