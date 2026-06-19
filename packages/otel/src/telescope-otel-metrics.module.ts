import { type DynamicModule, Module } from '@nestjs/common';
import { TELESCOPE_OTEL_EXPORTER, TelescopeOtelMetricsController } from './metrics.controller.js';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';

/**
 * Mounts `GET /metrics` (Prometheus) for the exporter. Pass the SAME exporter
 * instance you registered as a Telescope extension so the scrape reflects live
 * records. Mount path is owned by the host (e.g. via RouterModule or the module
 * import site).
 */
@Module({})
export class TelescopeOtelMetricsModule {
  static forExporter(exporter: TelescopeOtelExporter): DynamicModule {
    return {
      module: TelescopeOtelMetricsModule,
      controllers: [TelescopeOtelMetricsController],
      providers: [{ provide: TELESCOPE_OTEL_EXPORTER, useValue: exporter }],
    };
  }
}
