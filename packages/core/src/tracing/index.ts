// packages/core/src/tracing/index.ts
export {
  type PropagationOptions,
  type ResolvedPropagation,
  isPropagationTarget,
  resolvePropagation,
} from './config.js';
export { injectIntoClientRequest, injectIntoUndiciRequest } from './outbound.js';
export { attachTracingToAxios, injectIntoAxiosConfig } from './axios.js';
export {
  TELESCOPE_TRACING_KEY,
  type TelescopeTracingSlot,
  type TraceCarrier,
  currentSpanLinks,
  currentTraceId,
  outgoingTraceHeaders,
} from './runtime.js';
export { type TraceScope, currentTraceScope, newTraceScope, runInTraceScope } from './scope.js';
export {
  type TraceParent,
  formatTraceparent,
  isTraceId,
  parseTraceparent,
  parseTracestate,
} from './traceparent.js';
export { TelescopeTracing } from './tracing.service.js';
