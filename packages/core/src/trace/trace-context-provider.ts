// packages/core/src/trace/trace-context-provider.ts

/**
 * The ambient trace identifiers resolved at the moment an entry is recorded.
 * Both ids are the lower-case hex strings used by the W3C trace context /
 * OpenTelemetry spans they originate from.
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
}

/**
 * SPI for resolving the ambient OpenTelemetry trace context at record time.
 *
 * Implementations are invoked once per recorded entry, so `current()` MUST be
 * cheap. It MUST NOT throw under any circumstance — return `null` when there is
 * no active span / no tracer instead of letting an error escape, so that
 * recording never fails because of trace resolution.
 */
export interface TraceContextProvider {
  /** The active trace context, or `null` when no span / no tracer is available. */
  current(): TraceContext | null;
}
