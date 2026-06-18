import { dynamicController, normalizeTelescopePath } from '@dudousxd/nestjs-telescope';
import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { TelescopeUiController } from './telescope-ui.controller.js';
import { TELESCOPE_UI_OPTIONS, type TelescopeUiModuleOptions } from './telescope-ui.options.js';

@Module({})
export class TelescopeUiModule {
  static forRoot(options: TelescopeUiModuleOptions = {}): DynamicModule {
    const path = normalizeTelescopePath(options.path);
    return {
      module: TelescopeUiModule,
      controllers: [dynamicController(TelescopeUiController, path)],
      providers: [{ provide: TELESCOPE_UI_OPTIONS, useValue: options }],
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
  }): DynamicModule {
    const path = normalizeTelescopePath(config.path);
    const { useFactory } = config;
    return {
      module: TelescopeUiModule,
      imports: config.imports ?? [],
      controllers: [dynamicController(TelescopeUiController, path)],
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
    };
  }
}
