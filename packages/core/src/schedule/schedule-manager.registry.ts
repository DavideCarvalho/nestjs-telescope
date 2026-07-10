// packages/core/src/schedule/schedule-manager.registry.ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_OPTIONS,
  type TelescopeModuleOptions,
} from '../nest/telescope.options.js';
import type { Watcher } from '../nest/watcher.js';
import type { ScheduleManager, ScheduleManagerContext } from './schedule-manager.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Duck-types the `ScheduleManager` SPI (see {@link ScheduleManager}) against a
 * `watchers` entry so `ScheduleWatcher`-style classes that implement BOTH
 * `Watcher` and `ScheduleManager` (e.g. the `@nestjs/schedule` watcher) don't
 * need to also be listed in `scheduleManagers` — forgetting one of the two
 * arrays used to leave `/schedules/live` silently empty.
 *
 * Matches the FULL required SPI shape (every non-optional member — currently
 * just `listTasks`) to avoid false-positiving on an unrelated watcher that
 * happens to expose an unrelated `listTasks` method. `init` is optional on the
 * SPI so it is intentionally not part of the check.
 */
function isScheduleManager(watcher: Watcher): watcher is Watcher & ScheduleManager {
  return typeof (watcher as Partial<ScheduleManager>).listTasks === 'function';
}

@Injectable()
export class ScheduleManagerRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduleManagerRegistry.name);
  private readonly managers: ScheduleManager[] = [];

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Build the shared context handed to managers (init + list). */
  context(): ScheduleManagerContext {
    return { moduleRef: this.moduleRef, config: this.config };
  }

  /**
   * Explicit `scheduleManagers` plus any `watchers` entry that structurally
   * implements the `ScheduleManager` SPI (see {@link isScheduleManager}),
   * deduped by identity — a watcher instance listed in BOTH `watchers` and
   * `scheduleManagers` is only inited/registered once.
   */
  private candidates(): ScheduleManager[] {
    const explicit = this.options.scheduleManagers ?? [];
    const seen = new Set<ScheduleManager>(explicit);
    const fromWatchers = (this.options.watchers ?? []).filter(
      (watcher): watcher is Watcher & ScheduleManager =>
        isScheduleManager(watcher) && !seen.has(watcher),
    );
    return [...explicit, ...fromWatchers];
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) return;
    const ctx = this.context();
    for (const manager of this.candidates()) {
      try {
        await manager.init?.(ctx);
        this.managers.push(manager);
      } catch (error) {
        this.logger.error(`ScheduleManager failed to init: ${errorMessage(error)}`);
      }
    }
    if (this.managers.length > 0) {
      this.logger.log(`Telescope schedule managers: ${this.managers.length}`);
    }
  }

  all(): ScheduleManager[] {
    return [...this.managers];
  }
}
