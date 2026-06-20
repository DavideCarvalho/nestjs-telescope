// packages/otel/src/index.ts
export * from './otel-trace-context-provider.js';
export {
  TelescopeOtelExporter,
  type TelescopeOtelExporterOptions,
} from './telescope-otel-exporter.js';
export { TelescopeOtelMetricsModule } from './telescope-otel-metrics.module.js';
export { TELESCOPE_OTEL_EXPORTER, TelescopeOtelMetricsController } from './metrics.controller.js';
export { mapInput, MetricStore, type MetricSample } from './instrument-map.js';
export { entryToSpan, type SpanShape } from './entry-to-span.js';
