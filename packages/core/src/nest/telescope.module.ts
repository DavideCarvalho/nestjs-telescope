// packages/core/src/nest/telescope.module.ts
import { type DynamicModule, Module, type Provider, type InjectionToken, type OptionalFactoryDependency } from '@nestjs/common';
import { resolveConfig } from '../config/resolve-config.js';
import { SqliteStorageProvider } from '../storage/sqlite-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { TelescopeController } from './telescope.controller.js';
import { TelescopeGuard } from './telescope.guard.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_OPTIONS,
  TELESCOPE_STORAGE,
  type TelescopeModuleOptions,
} from './telescope.options.js';
import { TelescopePruner } from './telescope-pruner.service.js';
import { TelescopeService } from './telescope.service.js';

const SHARED_PROVIDERS: Provider[] = [
  {
    provide: TELESCOPE_CONFIG,
    useFactory: (options: TelescopeModuleOptions) => resolveConfig(options),
    inject: [TELESCOPE_OPTIONS],
  },
  {
    provide: TELESCOPE_STORAGE,
    useFactory: (options: TelescopeModuleOptions): StorageProvider =>
      options.storage ?? new SqliteStorageProvider(),
    inject: [TELESCOPE_OPTIONS],
  },
  TelescopeService,
  TelescopeGuard,
  TelescopePruner,
];

@Module({})
export class TelescopeModule {
  static forRoot(options: TelescopeModuleOptions = {}): DynamicModule {
    return {
      module: TelescopeModule,
      controllers: [TelescopeController],
      providers: [{ provide: TELESCOPE_OPTIONS, useValue: options }, ...SHARED_PROVIDERS],
      exports: [TelescopeService, TELESCOPE_STORAGE],
    };
  }

  static forRootAsync(config: {
    useFactory: (...args: unknown[]) => Promise<TelescopeModuleOptions> | TelescopeModuleOptions;
    inject?: (InjectionToken | OptionalFactoryDependency)[];
    imports?: DynamicModule['imports'];
  }): DynamicModule {
    return {
      module: TelescopeModule,
      ...(config.imports ? { imports: config.imports } : {}),
      controllers: [TelescopeController],
      providers: [
        {
          provide: TELESCOPE_OPTIONS,
          useFactory: config.useFactory,
          inject: config.inject ?? [],
        },
        ...SHARED_PROVIDERS,
      ],
      exports: [TelescopeService, TELESCOPE_STORAGE],
    };
  }
}
