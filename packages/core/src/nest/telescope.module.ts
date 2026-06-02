// packages/core/src/nest/telescope.module.ts
import {
  type DynamicModule,
  type InjectionToken,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OptionalFactoryDependency,
  type Provider,
  RequestMethod,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { resolveConfig } from '../config/resolve-config.js';
import { SqliteStorageProvider } from '../storage/sqlite-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { TelescopeExceptionInterceptor } from './telescope-exception.interceptor.js';
import { TelescopePruner } from './telescope-pruner.service.js';
import { TelescopeRequestMiddleware } from './telescope-request.middleware.js';
import { TelescopeWatcherRegistrar } from './telescope-watcher-registrar.service.js';
import { TelescopeController } from './telescope.controller.js';
import { TelescopeGuard } from './telescope.guard.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_OPTIONS,
  TELESCOPE_STORAGE,
  type TelescopeModuleOptions,
} from './telescope.options.js';
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
  TelescopeRequestMiddleware,
  TelescopeWatcherRegistrar,
  { provide: APP_INTERCEPTOR, useClass: TelescopeExceptionInterceptor },
];

@Module({})
export class TelescopeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TelescopeRequestMiddleware)
      .exclude({ path: 'telescope/api/{*splat}', method: RequestMethod.ALL })
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }

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
