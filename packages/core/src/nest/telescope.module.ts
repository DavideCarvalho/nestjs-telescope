// packages/core/src/nest/telescope.module.ts
import 'reflect-metadata';
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
  type Type,
} from '@nestjs/common';
import { APP_INTERCEPTOR, DiscoveryModule, ModuleRef } from '@nestjs/core';
import { AiUsageService } from '../agent-metrics/ai-usage.service.js';
import { normalizeTelescopePath } from '../config/normalize-path.js';
import type { ResolvedCoreConfig } from '../config/options.js';
import { resolveConfig } from '../config/resolve-config.js';
import { ExtensionRegistry } from '../extension/registry.js';
import { QueueMetricsService } from '../metrics/queue-metrics.service.js';
import { ServerStatsService } from '../metrics/server-stats.service.js';
import { StatsService } from '../metrics/stats.service.js';
import { TimeseriesService } from '../metrics/timeseries.service.js';
import { TracesService } from '../metrics/traces.service.js';
import { ProfilerService } from '../profiling/profiler.service.js';
import { PulseService } from '../pulse/pulse.service.js';
import { QueueManagerRegistry } from '../queue/queue-manager.registry.js';
import { ScheduleManagerRegistry } from '../schedule/schedule-manager.registry.js';
import { EntryEvents } from '../sse/entry-events.js';
import { StreamController } from '../sse/stream.controller.js';
import { SqliteStorageProvider } from '../storage/sqlite-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { ClientErrorController } from './client-error.controller.js';
import {
  CONSOLE_DECORATORS_EXAMPLE,
  assertConsoleProtected,
  dynamicController,
} from './dynamic-controller.js';
import { createExtensionContext } from './extension-context.factory.js';
import { TelescopeCrashCapture } from './telescope-crash-capture.service.js';
import { TelescopeExceptionInterceptor } from './telescope-exception.interceptor.js';
import { TelescopeMcpController } from './telescope-mcp.controller.js';
import { TelescopeOverloadGuard } from './telescope-overload-guard.service.js';
import { TelescopePruner } from './telescope-pruner.service.js';
import { TelescopeRequestMiddleware } from './telescope-request.middleware.js';
import { TelescopeWatcherRegistrar } from './telescope-watcher-registrar.service.js';
import { TelescopeController } from './telescope.controller.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_EXTENSIONS,
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
  {
    provide: TELESCOPE_EXTENSIONS,
    useFactory: (
      options: TelescopeModuleOptions,
      config: ResolvedCoreConfig,
      moduleRef: ModuleRef,
    ): ExtensionRegistry =>
      new ExtensionRegistry(options.extensions ?? [], createExtensionContext(moduleRef, config)),
    inject: [TELESCOPE_OPTIONS, TELESCOPE_CONFIG, ModuleRef],
  },
  EntryEvents,
  TelescopeService,
  TelescopePruner,
  QueueMetricsService,
  TimeseriesService,
  TracesService,
  StatsService,
  AiUsageService,
  {
    // Factory (not a bare class) so the host's `pulse` config — notably the
    // `slowRouteMs` slow-route hotspot threshold — reaches PulseService's
    // @Optional() options param. A bare class provider leaves it undefined.
    provide: PulseService,
    useFactory: (options: TelescopeModuleOptions, storage: StorageProvider) =>
      new PulseService(storage, options.pulse),
    inject: [TELESCOPE_OPTIONS, TELESCOPE_STORAGE],
  },
  ServerStatsService,
  {
    // Factory so the resolved profiling config + the TelescopeService record sink
    // reach the service. Constructed unconditionally (cheap); it NEVER builds a
    // profiler or loads `node:inspector` while `profiling.enabled` is false.
    provide: ProfilerService,
    useFactory: (config: ResolvedCoreConfig, service: TelescopeService) =>
      new ProfilerService(config.profiling, {
        record: (input) => service.record(input),
      }),
    inject: [TELESCOPE_CONFIG, TelescopeService],
  },
  TelescopeRequestMiddleware,
  TelescopeWatcherRegistrar,
  // Process-level crash capture. Constructed unconditionally (cheap); it
  // registers NO process listeners unless `exceptions.processCrashes.enabled`
  // is true, because attaching them changes the host's crash semantics.
  TelescopeCrashCapture,
  TelescopeOverloadGuard,
  QueueManagerRegistry,
  ScheduleManagerRegistry,
  { provide: APP_INTERCEPTOR, useClass: TelescopeExceptionInterceptor },
];

/**
 * Everything a host controller needs to serve Telescope's routes itself
 * (`routes: false`, or extending the exported controller classes): each
 * controller's dependencies, plus the services hosts already used.
 */
const TELESCOPE_EXPORTS = [
  TelescopeService,
  TELESCOPE_STORAGE,
  TELESCOPE_EXTENSIONS,
  TELESCOPE_OPTIONS,
  TELESCOPE_CONFIG,
  EntryEvents,
  TelescopePruner,
  QueueMetricsService,
  TimeseriesService,
  TracesService,
  StatsService,
  AiUsageService,
  PulseService,
  ServerStatsService,
  ProfilerService,
  QueueManagerRegistry,
  ScheduleManagerRegistry,
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
    return TelescopeModule.build(options, {
      provide: TELESCOPE_OPTIONS,
      useValue: options,
    });
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
    /**
     * Class decorators applied to the console controllers the module mounts. Must be
     * passed HERE (not inside the async-resolved options) because they shape the
     * routes at module-build time, before any factory runs — the SAME constraint
     * as `path` above. See {@link TelescopeModuleOptions.decorators}.
     */
    decorators?: ClassDecorator[];
    /**
     * `false` mounts no controller (serve the routes from your own). Must be
     * passed HERE (not inside the async-resolved options): which controllers
     * exist is decided at module-build time — the SAME constraint as `path`
     * above. See {@link TelescopeModuleOptions.routes}.
     */
    routes?: boolean;
  }): DynamicModule {
    // `config` carries the build-time fields under the same names.
    return TelescopeModule.build(config, {
      provide: TELESCOPE_OPTIONS,
      useFactory: config.useFactory,
      inject: config.inject ?? [],
    });
  }

  /**
   * Shared by `forRoot` / `forRootAsync`. `staticOptions` carries only what is
   * read at module-build time (`path`, `decorators`, `routes`, `imports`); everything else reaches the providers through `optionsProvider`.
   */
  private static build(
    staticOptions: Pick<TelescopeModuleOptions, 'path' | 'decorators' | 'routes' | 'imports'>,
    optionsProvider: Provider,
  ): DynamicModule {
    if (staticOptions.routes !== false) {
      const api = `${normalizeTelescopePath(staticOptions.path)}/api`;
      assertConsoleProtected(staticOptions.decorators, {
        module: 'TelescopeModule',
        decoratorsExample: `TelescopeModule.forRoot({ ${CONSOLE_DECORATORS_EXAMPLE} })`,
        selfMountExample: `TelescopeModule.forRoot({ routes: false }) + @Controller('${api}') @Can(ConsolePolicy, 'view') class ConsoleApi extends TelescopeController {}`,
      });
    }
    return {
      module: TelescopeModule,
      imports: [DiscoveryModule, ...(staticOptions.imports ?? [])],
      controllers: staticOptions.routes === false ? [] : TelescopeModule.controllers(staticOptions),
      providers: [optionsProvider, ...SHARED_PROVIDERS],
      exports: TELESCOPE_EXPORTS,
    };
  }

  /** The controllers mounted when `routes` is not `false`, in mount order. */
  private static controllers(
    staticOptions: Pick<TelescopeModuleOptions, 'path' | 'decorators'>,
  ): Type[] {
    const path = normalizeTelescopePath(staticOptions.path);
    const decorators = staticOptions.decorators ?? [];
    return [
      // Public front-end error beacon: guests' browsers must reach it, so it
      // takes NO `decorators` (only the Can.Anyone mark). It 404s while
      // `clientErrors.enabled` is off. Mounts before the catch-all controller.
      dynamicController(ClientErrorController, `${path}/api/client-errors`),
      dynamicController(TelescopeMcpController, `${path}/api/mcp`, decorators),
      dynamicController(TelescopeController, `${path}/api`, decorators),
      dynamicController(StreamController, `${path}/api`, decorators),
    ];
  }
}
