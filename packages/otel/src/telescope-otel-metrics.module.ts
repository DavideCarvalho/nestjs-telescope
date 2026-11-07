import { applyControllerDecorators, assertConsoleProtected } from '@dudousxd/nestjs-telescope';
import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { TELESCOPE_OTEL_EXPORTER, TelescopeOtelMetricsController } from './metrics.controller.js';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';

export interface TelescopeOtelMetricsModuleOptions {
  /**
   * Class decorators applied to the `GET /metrics` controller, the same shape
   * as `@nestjs/mcp`'s `decorators`, e.g.
   * `[UseGuards(AuthenticationGuard), Can(MetricsPolicy, 'scrape')]` with
   * `@nestjs/authentication` + `@nestjs/authorization`.
   *
   * PRODUCTION RULE: with `NODE_ENV === 'production'`, mounting the scrape with
   * no `decorators` (an empty array counts as none) fails the boot, the same
   * rule as the console's; protect it here or mount it yourself with
   * {@link routes}`: false`. Outside production an undecorated scrape mounts open.
   *
   * The controller is also marked open to `@nestjs/authorization`'s
   * deny-by-default global `AuthorizationGuard` (as `@Can.Anyone()` would), so an
   * undecorated dev scrape keeps answering when that package is adopted. A
   * `Can(...)` passed here is still enforced. Applied to a fresh subclass per
   * call, so nothing leaks between registrations.
   */
  decorators?: ClassDecorator[];
  /**
   * `false` mounts no controller; the module only provides the exporter under
   * `TELESCOPE_OTEL_EXPORTER` (exported), so a controller of your own can serve
   * the scrape, protected with ordinary Nest decorators: extend the exported
   * `TelescopeOtelMetricsController`, or call `exporter.prometheus()` yourself.
   * Named `routes` like core's and the UI's option (there `path` keeps a job
   * without routes; one name across the library). `decorators` is ignored
   * here. Default `true`.
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
    assertConsoleProtected(options.decorators, {
      module: 'TelescopeOtelMetricsModule',
      decoratorsExample:
        "TelescopeOtelMetricsModule.forExporter(exporter, { decorators: [UseGuards(AuthenticationGuard), Can(MetricsPolicy, 'scrape')] })",
      selfMountExample:
        "TelescopeOtelMetricsModule.forExporter(exporter, { routes: false }) + @Controller() @Can(MetricsPolicy, 'scrape') class Metrics extends TelescopeOtelMetricsController {}",
    });
    // A fresh subclass per call: inherits the route + constructor metadata, and
    // takes this call's decorators without touching the shared base class.
    class MetricsController extends TelescopeOtelMetricsController {}
    Object.defineProperty(MetricsController, 'name', {
      value: TelescopeOtelMetricsController.name,
    });
    const controller = applyControllerDecorators(MetricsController, options.decorators);
    return {
      module: TelescopeOtelMetricsModule,
      controllers: [controller as Type],
      providers,
      exports: [TELESCOPE_OTEL_EXPORTER],
    };
  }
}
