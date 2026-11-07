import { applyControllerDecorators } from '@dudousxd/nestjs-telescope';
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
   * DEFAULT: the controller is marked open to `@nestjs/authorization`'s
   * deny-by-default global `AuthorizationGuard` (as `@Can.Anyone()` would), so
   * the scrape keeps answering when that package is adopted. A `Can(...)`
   * passed here is still enforced. Applied to a fresh subclass per call, so
   * nothing leaks between registrations.
   */
  decorators?: ClassDecorator[];
}

/**
 * Mounts `GET /metrics` (Prometheus) for the exporter. Pass the SAME exporter
 * instance you registered as a Telescope extension so the scrape reflects live
 * records. Mount path is owned by the host (e.g. via RouterModule or the module
 * import site).
 */
@Module({})
export class TelescopeOtelMetricsModule {
  static forExporter(
    exporter: TelescopeOtelExporter,
    options: TelescopeOtelMetricsModuleOptions = {},
  ): DynamicModule {
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
      providers: [{ provide: TELESCOPE_OTEL_EXPORTER, useValue: exporter }],
    };
  }
}
