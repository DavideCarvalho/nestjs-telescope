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
import type { BatchOrigin, RecordInput } from '../entry/entry.js';
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
  }

  /** Normalized mount segment (no leading/trailing slash). Default `'telescope'`. */
  get path(): string {
    return this.config.path;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) return;
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
    };
  }
}
