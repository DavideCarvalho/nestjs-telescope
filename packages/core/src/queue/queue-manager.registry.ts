// packages/core/src/queue/queue-manager.registry.ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_OPTIONS,
  type TelescopeModuleOptions,
} from '../nest/telescope.options.js';
import { redact } from '../redaction/redact.js';
import type { QueueManager, QueueManagerContext } from './queue-manager.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) return;
    const ctx: QueueManagerContext = {
      moduleRef: this.moduleRef,
      config: this.config,
      redact: (value: unknown) => redact(value, this.config.redact),
    };
    for (const manager of this.options.queueManagers ?? []) {
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
