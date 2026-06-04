// packages/core/src/schedule/schedule-manager.registry.ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_OPTIONS,
  type TelescopeModuleOptions,
} from '../nest/telescope.options.js';
import type { ScheduleManager, ScheduleManagerContext } from './schedule-manager.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) return;
    const ctx = this.context();
    for (const manager of this.options.scheduleManagers ?? []) {
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
