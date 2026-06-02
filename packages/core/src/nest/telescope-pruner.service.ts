// packages/core/src/nest/telescope-pruner.service.ts
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { TELESCOPE_CONFIG, TELESCOPE_STORAGE } from './telescope.options.js';

@Injectable()
export class TelescopePruner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TelescopePruner.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
  ) {}

  onApplicationBootstrap(): void {
    const prune = this.config.prune;
    if (!this.config.enabled || !prune) return;
    this.timer = setInterval(() => {
      const cutoff = new Date(Date.now() - prune.afterMs);
      this.storage.prune(cutoff, prune.keepLast).catch((error: unknown) => {
        this.logger.warn(`Telescope prune failed: ${(error as Error).message}`);
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
}
