import 'reflect-metadata';
import {
  UseConsoleAuthorize,
  consoleAuthorizeMissingWarning,
  dynamicController,
  normalizeTelescopePath,
} from '@dudousxd/nestjs-telescope';
import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type OptionalFactoryDependency,
  type Type,
} from '@nestjs/common';
import { TelescopeUiController } from './telescope-ui.controller.js';
import { TELESCOPE_UI_OPTIONS, type TelescopeUiModuleOptions } from './telescope-ui.options.js';

/** The controller mounted when `routes` is not `false` (none when it is). */
function uiControllers(
  options: Pick<TelescopeUiModuleOptions, 'path' | 'decorators' | 'routes'>,
): Type[] {
  if (options.routes === false) return [];
  const path = normalizeTelescopePath(options.path);
  // `authorize` is read from the resolved options at init (it may come from an
  // async factory); the guard runs after the host's `decorators`.
  const access = UseConsoleAuthorize({
    from: {
      token: TELESCOPE_UI_OPTIONS,
      select: (resolved) => (resolved as TelescopeUiModuleOptions).authorize,
    },
    warn: true,
    missingWarning: consoleAuthorizeMissingWarning(
      '@dudousxd/nestjs-telescope-ui',
      'TelescopeUiModule.forRoot()',
    ),
    loggerContext: 'TelescopeUiModule',
  });
  return [dynamicController(TelescopeUiController, path, [...(options.decorators ?? []), access])];
}

@Module({})
export class TelescopeUiModule {
  static forRoot(options: TelescopeUiModuleOptions = {}): DynamicModule {
    return {
      module: TelescopeUiModule,
      imports: options.imports ?? [],
      controllers: uiControllers(options),
      providers: [{ provide: TELESCOPE_UI_OPTIONS, useValue: options }],
      exports: [TELESCOPE_UI_OPTIONS],
    };
  }

  static forRootAsync(config: {
    useFactory: (
      ...args: unknown[]
    ) => Promise<TelescopeUiModuleOptions> | TelescopeUiModuleOptions;
    inject?: (InjectionToken | OptionalFactoryDependency)[];
    imports?: DynamicModule['imports'];
    /**
     * Mount path for the dashboard. Must be passed statically here (not via the
     * async factory) because the controller route is bound at module-build time
     * — same constraint as `TelescopeModule.forRootAsync`. Defaults to
     * `'telescope'` and must match the core module's path.
     */
    path?: string;
    /**
     * Class decorators applied to the dashboard's controller. Must be passed
     * HERE (not inside the async-resolved options) because they shape the route
     * at module-build time, before any factory runs — the SAME constraint as
     * `path` above. See {@link TelescopeUiModuleOptions.decorators}.
     */
    decorators?: ClassDecorator[];
    /**
     * `false` mounts no controller. Must be passed HERE (not inside the
     * async-resolved options): which controllers exist is decided at
     * module-build time — the SAME constraint as `path` above. See
     * {@link TelescopeUiModuleOptions.routes}.
     */
    routes?: boolean;
  }): DynamicModule {
    const path = normalizeTelescopePath(config.path);
    const { useFactory } = config;
    return {
      module: TelescopeUiModule,
      imports: config.imports ?? [],
      controllers: uiControllers(config),
      providers: [
        {
          provide: TELESCOPE_UI_OPTIONS,
          // The mount `path` is bound statically at build time; force it onto the
          // async-resolved options so the controller's serve-time asset rewrite
          // matches the route mount (a factory that also returns `path` is
          // ignored — the static value wins, exactly as the route does).
          useFactory: async (...args: unknown[]): Promise<TelescopeUiModuleOptions> => ({
            ...(await useFactory(...args)),
            path,
          }),
          inject: config.inject ?? [],
        },
      ],
      exports: [TELESCOPE_UI_OPTIONS],
    };
  }
}
