// packages/core/src/queue/queue-manager.registry.ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_OPTIONS,
  type TelescopeModuleOptions,
} from '../nest/telescope.options.js';
import type { Watcher } from '../nest/watcher.js';
import { redact } from '../redaction/redact.js';
import type { QueueManager, QueueManagerContext } from './queue-manager.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Duck-types the `QueueManager` SPI (see {@link QueueManager}) against a
 * `watchers` entry so a watcher class that ALSO implements `QueueManager`
 * doesn't need to be listed in both `watchers` and `queueManagers` — mirrors
 * the same footgun `ScheduleManagerRegistry` closes for `ScheduleManager`.
 *
 * Matches the FULL required SPI shape (every non-optional member: `driver`,
 * `init`, `listQueues`, `counts`, `listJobs`, `getJob`) so an unrelated watcher
 * that happens to expose e.g. its own `listQueues` doesn't false-positive. The
 * Phase-2 action methods (`retry`/`remove`/`promote`/`retryAll`/`redrive`/
 * `enqueue`) are optional on the SPI and intentionally not part of the check.
 */
function isQueueManager(watcher: Watcher): watcher is Watcher & QueueManager {
  const candidate = watcher as Partial<QueueManager>;
  return (
    typeof candidate.driver === 'string' &&
    typeof candidate.init === 'function' &&
    typeof candidate.listQueues === 'function' &&
    typeof candidate.counts === 'function' &&
    typeof candidate.listJobs === 'function' &&
    typeof candidate.getJob === 'function'
  );
}

@Injectable()
export class QueueManagerRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueManagerRegistry.name);
  private readonly managers = new Map<string, QueueManager>();

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Build the shared context handed to managers (init + on-demand actions). */
  context(): QueueManagerContext {
    return {
      moduleRef: this.moduleRef,
      config: this.config,
      redact: (value: unknown) => redact(value, this.config.redact),
    };
  }

  /**
   * Explicit `queueManagers` plus any `watchers` entry that structurally
   * implements the `QueueManager` SPI (see {@link isQueueManager}), deduped by
   * identity — a watcher instance listed in BOTH `watchers` and
   * `queueManagers` is only inited/registered once.
   */
  private candidates(): QueueManager[] {
    const explicit = this.options.queueManagers ?? [];
    const seen = new Set<QueueManager>(explicit);
    const fromWatchers = (this.options.watchers ?? []).filter(
      (watcher): watcher is Watcher & QueueManager => isQueueManager(watcher) && !seen.has(watcher),
    );
    return [...explicit, ...fromWatchers];
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) return;
    const ctx = this.context();
    for (const manager of this.candidates()) {
      try {
        await manager.init(ctx);
        this.managers.set(manager.driver, manager);
      } catch (error) {
        this.logger.error(
          `QueueManager "${manager.driver}" failed to init: ${errorMessage(error)}`,
        );
      }
    }
    if (this.managers.size > 0) {
      this.logger.log(`Telescope queue drivers: ${[...this.managers.keys()].join(', ')}`);
    }
  }

  drivers(): string[] {
    return [...this.managers.keys()];
  }
  get(driver: string): QueueManager | undefined {
    return this.managers.get(driver);
  }
  all(): QueueManager[] {
    return [...this.managers.values()];
  }
}
