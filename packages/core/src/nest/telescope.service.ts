// packages/core/src/nest/telescope.service.ts
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { v7 } from 'uuid';
import type { ResolvedCoreConfig } from '../config/options.js';
import { createBatch } from '../context/batch.js';
import { TelescopeContext } from '../context/telescope-context.js';
import { setTelescopeDump } from '../dump/telescope-dump.js';
import { type BatchOrigin, EntryType, type RecordInput } from '../entry/entry.js';
import { Recorder } from '../recorder/recorder.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import {
  TELESCOPE_CONFIG,
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
  /** Resolved retention window from `prune`, or `null` when unbounded. */
  retention: { afterMs: number; keepLast: number | null } | null;
  /** Resolved per-type sample rates (0..1). Empty when no sampling configured. */
  sampling: Record<string, number>;
}

@Injectable()
export class TelescopeService implements OnModuleInit, OnApplicationShutdown {
  readonly context = new TelescopeContext();
  private readonly recorder: Recorder;
  private readonly logger = new Logger(TelescopeService.name);
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private watcherTypes: string[] = [];

  constructor(
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
  ) {
    this.recorder = new Recorder({
      storage,
      context: this.context,
      instanceId: config.instanceId,
      taggers: config.taggers,
      redact: config.redact,
      sampling: config.sampling,
      bufferSize: config.recorder.bufferSize,
      idFactory: () => v7(),
      ...(config.filter ? { filter: config.filter } : {}),
      ...(config.traceContext ? { traceContext: config.traceContext } : {}),
    });
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
  }

  async onApplicationShutdown(): Promise<void> {
    // Detach the global dump sink so stray post-shutdown calls become no-ops.
    setTelescopeDump(null);
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
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

  async getMeta(): Promise<TelescopeMeta> {
    return {
      enabled: this.config.enabled,
      droppedCount: this.recorder.droppedCount,
      watchers: [...this.watcherTypes],
      traceLink: this.config.traceLink ?? null,
      retention: this.config.prune
        ? {
            afterMs: this.config.prune.afterMs,
            keepLast: this.config.prune.keepLast ?? null,
          }
        : null,
      sampling: { ...this.config.sampling },
    };
  }
}
