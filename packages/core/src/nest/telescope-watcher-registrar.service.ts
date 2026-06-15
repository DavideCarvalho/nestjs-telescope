// packages/core/src/nest/telescope-watcher-registrar.service.ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import { EntryType } from '../entry/entry.js';
import { ExtensionRegistry } from '../extension/registry.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_EXTENSIONS,
  TELESCOPE_OPTIONS,
  type TelescopeModuleOptions,
} from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';
import { createWatcherContext } from './watcher-context.factory.js';

@Injectable()
export class TelescopeWatcherRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelescopeWatcherRegistrar.name);

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    @Inject(TelescopeService) private readonly service: TelescopeService,
    @Inject(TELESCOPE_EXTENSIONS) private readonly extensions: ExtensionRegistry,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) return;
    const watchers = [...(this.options.watchers ?? []), ...this.extensions.watchers()];
    const ctx = createWatcherContext(this.service, this.config, this.moduleRef);
    const registered: string[] = [];
    for (const watcher of watchers) {
      try {
        await watcher.register(ctx);
        // Only report a watcher as active once it has actually wired up — a
        // failed register() must not show as "watching" in /meta.
        registered.push(watcher.type);
      } catch (error) {
        this.logger.error(
          `Telescope watcher "${watcher.type}" failed to register: ${(error as Error).message}`,
        );
      }
    }
    // Client-error ingestion isn't a "watcher" (no register() call), but the
    // dashboard's watcher-driven nav keys the "Client errors" tab off the meta
    // list — so surface its type only when the public endpoint is enabled.
    const clientErrorTypes =
      this.options.clientErrors?.enabled === true ? [EntryType.ClientException] : [];
    const extensionTypes = this.extensions.entryTypes().map((e) => e.id);
    const types = [
      EntryType.Request,
      EntryType.Exception,
      ...registered,
      ...clientErrorTypes,
      ...extensionTypes,
    ];
    this.service.setWatchers(types);
    this.logger.log(`Telescope watching: ${types.join(', ')}`);
  }
}
