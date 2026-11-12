import {
  type ConsoleAuthorize,
  UseConsoleAuthorize,
  applyControllerDecorators,
  consoleAuthorizeMissingWarning,
} from '@dudousxd/nestjs-telescope';
import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { TELESCOPE_OTEL_EXPORTER, TelescopeOtelMetricsController } from './metrics.controller.js';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';

export interface TelescopeOtelMetricsModuleOptions {
  /**
   * Who may scrape `GET /metrics`: the same contract as the console's
   * `authorize` (a function, an `@Injectable()` `ConsoleAuthorizer` class, a
   * lazy import, `{ policy, ability }`, a gate name). Prometheus sends a
   * Bearer token (`authorization.credentials` in its scrape config), so the
   * usual value is:
   *
   * ```ts
   * authorize: authorizeByToken({ token: process.env.METRICS_TOKEN })
   * ```
   *
   * Omitted: open outside production; with `NODE_ENV === 'production'` every
   * scrape answers 403, and one warning is logged at boot.
   */
  authorize?: ConsoleAuthorize;
  /**
   * Class decorators applied to the `GET /metrics` controller, the same shape
   * as `@nestjs/mcp`'s `decorators` (authentication, throttling, ...). They run
   * before {@link authorize}; on their own they do not configure access.
   *
   * The controller is also marked open to `@nestjs/authorization`'s
   * deny-by-default global `AuthorizationGuard` (as `@Can.Anyone()` would), so
   * that guard does not lock the scrape out; `authorize` decides. A
   * `Can(...)` passed here is still enforced. Applied to a fresh subclass per
   * call, so nothing leaks between registrations.
   */
  decorators?: ClassDecorator[];
  /**
   * `false` mounts no controller; the module only provides the exporter under
   * `TELESCOPE_OTEL_EXPORTER` (exported), so a controller of your own can serve
   * the scrape: extend the exported `TelescopeOtelMetricsController` and put
   * `@UseConsoleAuthorize({ authorize })` on it (above any authentication guard
   * of yours, so that guard runs first), or call `exporter.prometheus()` yourself.
   * Named `routes` like core's and the UI's option (there `path` keeps a job
   * without routes; one name across the library). `decorators` is ignored
   * here, and so is `authorize`. Default `true`.
   */
  routes?: boolean;
}

/**
 * Mounts `GET /metrics` (Prometheus) for the exporter. Pass the SAME exporter
 * instance you registered as a Telescope extension so the scrape reflects live
 * records. Mount path is owned by the host (e.g. via RouterModule or the module
 * import site). `routes: false` mounts nothing, for a controller of your own.
 */
@Module({})
export class TelescopeOtelMetricsModule {
  static forExporter(
    exporter: TelescopeOtelExporter,
    options: TelescopeOtelMetricsModuleOptions = {},
  ): DynamicModule {
    const providers = [{ provide: TELESCOPE_OTEL_EXPORTER, useValue: exporter }];
    if (options.routes === false) {
      return {
        module: TelescopeOtelMetricsModule,
        providers,
        exports: [TELESCOPE_OTEL_EXPORTER],
      };
    }
    // A fresh subclass per call: inherits the route + constructor metadata, and
    // takes this call's decorators without touching the shared base class.
    class MetricsController extends TelescopeOtelMetricsController {}
    Object.defineProperty(MetricsController, 'name', {
      value: TelescopeOtelMetricsController.name,
    });
    const controller = applyControllerDecorators(MetricsController, [
      ...(options.decorators ?? []),
      UseConsoleAuthorize({
        authorize: options.authorize,
        // `/metrics` has its own `authorize`: never the console's.
        inherit: false,
        warn: true,
        missingWarning: consoleAuthorizeMissingWarning(
          '@dudousxd/nestjs-telescope-otel',
          'TelescopeOtelMetricsModule.forExporter()',
        ),
        loggerContext: 'TelescopeOtelMetricsModule',
      }),
    ]);
    return {
      module: TelescopeOtelMetricsModule,
      controllers: [controller as Type],
      providers,
      exports: [TELESCOPE_OTEL_EXPORTER],
    };
  }
}
