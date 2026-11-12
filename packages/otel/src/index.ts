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
  ConsoleAccessDenied,
  ConsoleAuthorizeFilter,
  ConsoleAuthorizeGuard,
  ConsolePage,
  UseConsoleAuthorize,
  authorizeByToken,
  normalizeConsoleResult,
  resolveConsoleAuthorize,
  type ConsoleAuthorize,
  type ConsoleAuthorizeResult,
  type ConsoleAuthorizer,
  type ConsoleAuthorizerClass,
  type ConsoleDecide,
  type ConsoleDecision,
  type ConsolePolicyCheck,
  type UseConsoleAuthorizeOptions,
} from '@dudousxd/nestjs-telescope';
