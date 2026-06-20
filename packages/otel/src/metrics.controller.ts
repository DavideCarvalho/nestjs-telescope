import { Controller, Get, Header, Inject } from '@nestjs/common';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';

export const TELESCOPE_OTEL_EXPORTER = Symbol.for('telescope-otel-exporter');

@Controller()
export class TelescopeOtelMetricsController {
  constructor(@Inject(TELESCOPE_OTEL_EXPORTER) private readonly exporter: TelescopeOtelExporter) {}

  /** Prometheus scrape of everything Telescope records. */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics(): string {
    return this.exporter.prometheus();
  }
}
