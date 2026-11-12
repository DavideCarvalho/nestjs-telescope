// packages/otel/src/index.ts
export * from './otel-trace-context-provider.js';
export {
  TelescopeOtelExporter,
  type TelescopeOtelExporterOptions,
} from './telescope-otel-exporter.js';
export {
  TelescopeOtelMetricsModule,
  type TelescopeOtelMetricsModuleOptions,
} from './telescope-otel-metrics.module.js';
export { TELESCOPE_OTEL_EXPORTER, TelescopeOtelMetricsController } from './metrics.controller.js';
export { mapInput, MetricStore, type MetricSample } from './instrument-map.js';
export { entryToSpan, type SpanShape } from './entry-to-span.js';
export {
  TelescopeAiMetricsExporter,
  type TelescopeAiMetricsExporterOptions,
  type OtelMetricsSdk,
} from './ai-metrics-exporter.js';
// The console access contract, re-exported from core so `/metrics`'s
// `authorize` can be written from this entry point.
export {
  ConsoleAuthorizeGuard,
  ConsoleDeniedFilter,
  UseConsoleAuthorize,
  authorizeByToken,
  resolveConsoleAuthorize,
  type ConsoleAuthorize,
  type ConsoleAuthorizeResult,
  type ConsoleAuthorizer,
  type ConsoleAuthorizerClass,
  type ConsoleDecision,
  type ConsolePolicyCheck,
} from '@dudousxd/nestjs-telescope';
