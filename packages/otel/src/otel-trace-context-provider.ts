import type { TraceContext, TraceContextProvider } from '@dudousxd/nestjs-telescope';
import { isSpanContextValid, trace } from '@opentelemetry/api';

/**
 * Reads the active OpenTelemetry span via @opentelemetry/api and exposes its
 * trace/span ids to Telescope. Wire it as `traceContext` in TelescopeModule
 * options. Degrades to null (no link) when no span is active or the API is
 * absent — never throws.
 */
export class OtelTraceContextProvider implements TraceContextProvider {
  current(): TraceContext | null {
    try {
      const span = trace.getActiveSpan();
      if (!span) return null;
      const spanContext = span.spanContext();
      if (!spanContext || !isSpanContextValid(spanContext)) return null;
      return { traceId: spanContext.traceId, spanId: spanContext.spanId };
    } catch {
      return null;
    }
  }
}
