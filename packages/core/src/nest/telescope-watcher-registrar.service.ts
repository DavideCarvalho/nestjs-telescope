// packages/core/src/nest/telescope-watcher-registrar.service.ts
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import { EntryType } from '../entry/entry.js';
import { TELESCOPE_CONFIG, TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';
import { createWatcherContext } from './watcher-context.factory.js';

@Injectable()
export class TelescopeWatcherRegistrar implements OnApplicationBootstrap {
  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    @Inject(TelescopeService) private readonly service: TelescopeService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) return;
    const watchers = this.options.watchers ?? [];
    const ctx = createWatcherContext(this.service, this.config, this.moduleRef);
    for (const watcher of watchers) {
      await watcher.register(ctx);
    }
    this.service.setWatchers([EntryType.Request, EntryType.Exception, ...watchers.map((w) => w.type)]);
  }
}
