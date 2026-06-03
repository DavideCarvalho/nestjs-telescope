// packages/core/src/nest/telescope.module.ts
import {
  type DynamicModule,
  Inject,
  type InjectionToken,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OptionalFactoryDependency,
  type Provider,
  RequestMethod,
} from '@nestjs/common';
import { APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { normalizeTelescopePath } from '../config/normalize-path.js';
import { resolveConfig } from '../config/resolve-config.js';
import { QueueMetricsService } from '../metrics/queue-metrics.service.js';
import { StatsService } from '../metrics/stats.service.js';
import { TimeseriesService } from '../metrics/timeseries.service.js';
import { PulseService } from '../pulse/pulse.service.js';
import { QueueManagerRegistry } from '../queue/queue-manager.registry.js';
import { SqliteStorageProvider } from '../storage/sqlite-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { dynamicController } from './dynamic-controller.js';
import { TelescopeActionGuard } from './telescope-action.guard.js';
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
  TelescopeActionGuard,
  TelescopePruner,
  QueueMetricsService,
  TimeseriesService,
  StatsService,
  PulseService,
  TelescopeRequestMiddleware,
  TelescopeWatcherRegistrar,
  QueueManagerRegistry,
  { provide: APP_INTERCEPTOR, useClass: TelescopeExceptionInterceptor },
];

@Module({})
export class TelescopeModule implements NestModule {
  constructor(@Inject(TELESCOPE_OPTIONS) private readonly moduleOptions: TelescopeModuleOptions) {}

  configure(consumer: MiddlewareConsumer): void {
    // Hosts that call `setGlobalPrefix(...)` should set
    // `registerRequestMiddleware: false` and instead register the capture
    // globally in their bootstrap via `app.use(telescopeRequestCapture(app.get(TelescopeService)))`.
    // Reason: NestJS scopes module middleware (even a `{*splat}` catch-all) to
    // the global-prefix's route table, so only `/` ends up captured. A raw
    // `app.use` runs before all route handlers regardless of prefix.
    if (this.moduleOptions.registerRequestMiddleware === false) {
      return;
    }
    // NestJS 11 / path-to-regexp v8 route syntax: {*splat} is the optional catch-all (the '*' and '(.*)' forms throw). Requires @nestjs/common >= 11 for the middleware path matching.
    // No .exclude(): under a global prefix .exclude() doesn't work with the catch-all route — it
    // forces NestJS into route-by-route matching so only '/' is captured. Telescope's own routes
    // (the /telescope dashboard, API and assets) are skipped inside TelescopeRequestMiddleware instead.
    consumer
      .apply(TelescopeRequestMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }

  static forRoot(options: TelescopeModuleOptions = {}): DynamicModule {
    const path = normalizeTelescopePath(options.path);
    return {
      module: TelescopeModule,
      imports: [DiscoveryModule],
      controllers: [dynamicController(TelescopeController, `${path}/api`)],
      providers: [{ provide: TELESCOPE_OPTIONS, useValue: options }, ...SHARED_PROVIDERS],
      exports: [
        TelescopeService,
        TELESCOPE_STORAGE,
        QueueMetricsService,
        TimeseriesService,
        StatsService,
        PulseService,
      ],
    };
  }

  static forRootAsync(config: {
    useFactory: (...args: unknown[]) => Promise<TelescopeModuleOptions> | TelescopeModuleOptions;
    inject?: (InjectionToken | OptionalFactoryDependency)[];
    imports?: DynamicModule['imports'];
    /**
     * Mount path for the dashboard + API. Must be passed statically here (not
     * via the async factory) because the controller route is bound at
     * module-build time. Defaults to `'telescope'`.
     */
    path?: string;
  }): DynamicModule {
    const path = normalizeTelescopePath(config.path);
    return {
      module: TelescopeModule,
      imports: [DiscoveryModule, ...(config.imports ?? [])],
      controllers: [dynamicController(TelescopeController, `${path}/api`)],
      providers: [
        {
          provide: TELESCOPE_OPTIONS,
          useFactory: config.useFactory,
          inject: config.inject ?? [],
        },
        ...SHARED_PROVIDERS,
      ],
      exports: [
        TelescopeService,
        TELESCOPE_STORAGE,
        QueueMetricsService,
        TimeseriesService,
        StatsService,
        PulseService,
      ],
    };
  }
}
