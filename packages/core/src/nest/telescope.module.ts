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
import { APP_INTERCEPTOR, DiscoveryModule, ModuleRef } from '@nestjs/core';
import { resolveDashboardAuth } from '../auth/dashboard-auth-config.js';
import { normalizeTelescopePath } from '../config/normalize-path.js';
import type { ResolvedCoreConfig } from '../config/options.js';
import { resolveConfig } from '../config/resolve-config.js';
import { ExtensionRegistry } from '../extension/registry.js';
import { QueueMetricsService } from '../metrics/queue-metrics.service.js';
import { ServerStatsService } from '../metrics/server-stats.service.js';
import { StatsService } from '../metrics/stats.service.js';
import { TimeseriesService } from '../metrics/timeseries.service.js';
import { TracesService } from '../metrics/traces.service.js';
import { PulseService } from '../pulse/pulse.service.js';
import { QueueManagerRegistry } from '../queue/queue-manager.registry.js';
import { ScheduleManagerRegistry } from '../schedule/schedule-manager.registry.js';
import { EntryEvents } from '../sse/entry-events.js';
import { StreamController } from '../sse/stream.controller.js';
import { SqliteStorageProvider } from '../storage/sqlite-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { ClientErrorController } from './client-error.controller.js';
import { dynamicController } from './dynamic-controller.js';
import { createExtensionContext } from './extension-context.factory.js';
import { TelescopeActionGuard } from './telescope-action.guard.js';
import { TelescopeAuthController } from './telescope-auth.controller.js';
import { TelescopeExceptionInterceptor } from './telescope-exception.interceptor.js';
import { TelescopeMcpController } from './telescope-mcp.controller.js';
import { TelescopeOverloadGuard } from './telescope-overload-guard.service.js';
import { TelescopePruner } from './telescope-pruner.service.js';
import { TelescopeRequestMiddleware } from './telescope-request.middleware.js';
import { TelescopeWatcherRegistrar } from './telescope-watcher-registrar.service.js';
import { TelescopeController } from './telescope.controller.js';
import { TelescopeGuard } from './telescope.guard.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_DASHBOARD_AUTH,
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
    // Boot-validated: a configured dashboardAuth with a missing secret / no hook
    // throws here at provider instantiation (fail closed). `null` when unset.
    provide: TELESCOPE_DASHBOARD_AUTH,
    useFactory: (options: TelescopeModuleOptions) => resolveDashboardAuth(options.dashboardAuth),
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
  TelescopeGuard,
  TelescopeActionGuard,
  TelescopePruner,
  QueueMetricsService,
  TimeseriesService,
  TracesService,
  StatsService,
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
  TelescopeRequestMiddleware,
  TelescopeWatcherRegistrar,
  TelescopeOverloadGuard,
  QueueManagerRegistry,
  ScheduleManagerRegistry,
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
      controllers: [
        // The auth controller mounts BEFORE the gated API controller so its
        // /api/auth/* routes resolve ahead of the catch-all and stay ungated
        // (it carries no @UseGuards(TelescopeGuard)).
        dynamicController(TelescopeAuthController, `${path}/api/auth`),
        // Public front-end error ingestion — also ungated (ordinary browsers
        // hit it). It enforces its own opt-in/rate-limit/authorize knobs and
        // 404s while disabled. Mounts before the catch-all gated controller.
        dynamicController(ClientErrorController, `${path}/api/client-errors`),
        // MCP server — ungated by TelescopeGuard (it enforces its own Bearer
        // token / dev-only check); mounts before the catch-all gated controller.
        dynamicController(TelescopeMcpController, `${path}/api/mcp`),
        dynamicController(TelescopeController, `${path}/api`),
        dynamicController(StreamController, `${path}/api`),
      ],
      providers: [{ provide: TELESCOPE_OPTIONS, useValue: options }, ...SHARED_PROVIDERS],
      exports: [
        TelescopeService,
        TELESCOPE_STORAGE,
        TELESCOPE_EXTENSIONS,
        QueueMetricsService,
        TimeseriesService,
        TracesService,
        StatsService,
        PulseService,
        ServerStatsService,
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
      controllers: [
        dynamicController(TelescopeAuthController, `${path}/api/auth`),
        dynamicController(ClientErrorController, `${path}/api/client-errors`),
        // MCP server — ungated by TelescopeGuard (it enforces its own Bearer
        // token / dev-only check); mounts before the catch-all gated controller.
        dynamicController(TelescopeMcpController, `${path}/api/mcp`),
        dynamicController(TelescopeController, `${path}/api`),
        dynamicController(StreamController, `${path}/api`),
      ],
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
        TELESCOPE_EXTENSIONS,
        QueueMetricsService,
        TimeseriesService,
        TracesService,
        StatsService,
        PulseService,
        ServerStatsService,
      ],
    };
  }
}
