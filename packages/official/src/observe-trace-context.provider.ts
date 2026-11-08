// packages/official/src/observe-trace-context.provider.ts
import { createHash } from 'node:crypto';
import type { TraceContext, TraceContextProvider } from '@dudousxd/nestjs-telescope';

/** The one method of `@nestjs/observe`'s `TracerService` this reads. */
export interface ObserveTracer {
  currentTraceId(): string | null | undefined;
}

const HEX32 = /^[0-9a-f]{32}$/;
const ZERO32 = '0'.repeat(32);

/**
 * `@nestjs/observe`'s trace id → the 32 lower-case hex digits Telescope (and W3C trace context)
 * use. Observe writes ids as UUIDs (`4bf92f35-77b3-4da6-a3ce-929d0e0e4736`), which are exactly 32
 * hex digits with dashes, so dropping the dashes gives the id Observe's dashboard shows and, with
 * `openTelemetry: true`, the W3C trace id. An id that is not hex — a proxy's free-form
 * `x-request-id`, which Observe keeps as the trace's name — is hashed (SHA-256, first 32 digits),
 * so every entry of that request still shares one trace. `null` for no id or the all-zero id.
 */
export function toW3cTraceId(id: string | null | undefined): string | null {
  if (typeof id !== 'string' || id === '') return null;
  const hex = id.replace(/-/g, '').toLowerCase();
  if (HEX32.test(hex)) return hex === ZERO32 ? null : hex;
  return createHash('sha256').update(id).digest('hex').slice(0, 32);
}

/**
 * Observe exposes no span id, so Telescope gets a synthetic one: 16 hex digits derived from the
 * trace id. Stable for a trace, so every entry of a request carries the same span (Telescope's
 * waterfall orders entries by time within a trace; it does not need a span tree).
 */
export function syntheticSpanId(traceId: string): string {
  return createHash('sha256').update(`span:${traceId}`).digest('hex').slice(0, 16);
}

/**
 * Telescope's `traceContext` from `@nestjs/observe`: stamps each entry with the trace id Observe
 * gives the request, so a Telescope entry and the same request in NestJS Observe share an id.
 *
 * ```ts
 * TelescopeModule.forRootAsync({
 *   inject: [TracerService],
 *   useFactory: (tracer: TracerService) => ({ traceContext: new ObserveTraceContextProvider(tracer) }),
 * })
 * ```
 *
 * It reads the trace id and nothing else. It never reads, receives or stores Observe's spans,
 * metrics or other telemetry: `@nestjs/observe` (0.3.20 and later) is under the NestJS Observe
 * Agent License, which only lets its telemetry go to observe.nestjs.com and forbids using it to
 * build a backend that receives that telemetry. The license permits passing trace context between
 * your applications and the services they call ("Passing trace context, such as traceparent or
 * x-request-id headers, between Your applications and the services they call does not violate (a)
 * or (b)"); stamping the id on local entries is in that spirit, and is what `currentTraceId()` is
 * documented for (logs, outgoing headers).
 *
 * Never throws: no tracer, no trace in flight, or a tracer that throws all give `null`.
 */
export class ObserveTraceContextProvider implements TraceContextProvider {
  private lastSource: string | null = null;
  private lastContext: TraceContext | null = null;

  constructor(private readonly tracer: ObserveTracer | null | undefined) {}

  current(): TraceContext | null {
    try {
      const id = this.tracer?.currentTraceId() ?? null;
      if (id === null) return null;
      // Every entry of a request asks for the same id: skip re-hashing it.
      if (id === this.lastSource) return this.lastContext;
      const traceId = toW3cTraceId(id);
      const context = traceId === null ? null : { traceId, spanId: syntheticSpanId(traceId) };
      this.lastSource = id;
      this.lastContext = context;
      return context;
    } catch {
      return null;
    }
  }
}
