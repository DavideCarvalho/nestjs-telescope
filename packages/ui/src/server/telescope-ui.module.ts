import 'reflect-metadata';
import { dynamicController, normalizeTelescopePath } from '@dudousxd/nestjs-telescope';
import {
  type CanActivate,
  type DynamicModule,
  type InjectionToken,
  Module,
  type OptionalFactoryDependency,
  type Type,
} from '@nestjs/common';
import { TelescopeUiController } from './telescope-ui.controller.js';
import { TELESCOPE_UI_OPTIONS, type TelescopeUiModuleOptions } from './telescope-ui.options.js';

/**
 * `@nestjs/common`'s own `GUARDS_METADATA` key, INLINED rather than deep-imported
 * from '@nestjs/common/constants' — that subpath has no extension and a strict
 * ESM resolver 404s on it (same convention used by core's `TelescopeModule` and
 * `@dudousxd/nestjs-agent`'s `agent-dashboard.module.ts`). A drift spec asserts
 * this literal stays byte-identical to the real constant.
 */
const GUARDS_METADATA = '__guards__';

/** Narrows a `guards` entry to a class (constructor), not an already-built instance. */
function isGuardClass(guard: Type<CanActivate> | CanActivate): guard is Type<CanActivate> {
  return typeof guard === 'function';
}

/**
 * Stamp host guards onto the dashboard's page/asset controller. `TelescopeUiController`
 * carries no guard of its own, so — unlike core's `stampGuards` — there is nothing to
 * preserve: this is a plain REPLACE of whatever (nothing) was there before. A no-op
 * when `guards` is omitted/empty, leaving the controller unguarded exactly as before.
 */
function stampGuards(
  guards: Array<Type<CanActivate> | CanActivate> | undefined,
  ...controllers: Type[]
): void {
  if (guards === undefined || guards.length === 0) return;
  for (const controller of controllers) {
    Reflect.defineMetadata(GUARDS_METADATA, guards, controller);
  }
}

@Module({})
export class TelescopeUiModule {
  static forRoot(options: TelescopeUiModuleOptions = {}): DynamicModule {
    const path = normalizeTelescopePath(options.path);
    const uiController = dynamicController(TelescopeUiController, path);
    stampGuards(options.guards, uiController);
    return {
      module: TelescopeUiModule,
      imports: options.imports ?? [],
      controllers: [uiController],
      providers: [
        { provide: TELESCOPE_UI_OPTIONS, useValue: options },
        ...(options.guards ?? []).filter(isGuardClass),
      ],
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
     * Guard classes (or instances) fronting the dashboard's page/asset
     * controller. Must be passed HERE (not inside the async-resolved options)
     * because guard stamping happens at module-build time, synchronously —
     * the SAME constraint as `path` above. See
     * {@link TelescopeUiModuleOptions.guards}. A class guard's dependencies
     * resolve from `imports` above.
     */
    guards?: Array<Type<CanActivate> | CanActivate>;
  }): DynamicModule {
    const path = normalizeTelescopePath(config.path);
    const uiController = dynamicController(TelescopeUiController, path);
    stampGuards(config.guards, uiController);
    const { useFactory } = config;
    return {
      module: TelescopeUiModule,
      imports: config.imports ?? [],
      controllers: [uiController],
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
        ...(config.guards ?? []).filter(isGuardClass),
      ],
    };
  }
}
