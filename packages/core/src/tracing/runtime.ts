// packages/core/src/tracing/runtime.ts
//
// What the booted module tells the request middleware, the outgoing hook and the BullMQ watcher:
// whether incoming traces are continued, whether requests start traces, and where a
// nestjs-context trace id comes from. On a `Symbol.for()` slot, like the scope.
import { activeOtelSpan, isTelescopeWork } from '../otel/telescope-runtime.js';
import { type TraceScope, currentTraceScope, newTraceScope, runInTraceScope } from './scope.js';
import {
  formatTraceparent,
  isTraceId,
  newSpanId,
  parseTraceparent,
  parseTracestate,
} from './traceparent.js';

/** @internal */
export interface TracingRuntime {
  /** Continue an incoming `traceparent`. */
  incoming: boolean;
  /** Start a trace for a request no caller sent one for. */
  startTraces: boolean;
  /** Carry the trace through queue jobs. */
  queue: boolean;
  /** The nestjs-context trace id of the current request, when the accessor is present. */
  contextTraceId(): string | undefined;
}

const RUNTIME_KEY = Symbol.for('@dudousxd/nestjs-telescope:tracing-runtime');
const slot = globalThis as Record<symbol, unknown>;
const DEFAULT_RUNTIME: TracingRuntime = {
  incoming: false,
  startTraces: false,
  queue: false,
  contextTraceId: () => undefined,
};

/** The active runtime (defaults: nothing continued, nothing started). */
export function tracingRuntime(): TracingRuntime {
  return (slot[RUNTIME_KEY] as TracingRuntime | undefined) ?? DEFAULT_RUNTIME;
}

/** Install `runtime`; returns the function that removes it (if still the installed one). */
export function setTracingRuntime(runtime: TracingRuntime): () => void {
  slot[RUNTIME_KEY] = runtime;
  return () => {
    if (slot[RUNTIME_KEY] === runtime) slot[RUNTIME_KEY] = undefined;
  };
}

/**
 * The trace id of the current unit of work: the active OpenTelemetry span, then the caller's trace,
 * then nestjs-context's, then the one telescope started. `null` outside all of them.
 */
export function currentTraceId(): string | null {
  const otel = activeOtelSpan();
  if (otel !== undefined) return otel.traceId;
  const scope = currentTraceScope();
  if (scope?.upstreamTraceId) return scope.upstreamTraceId;
  let fromContext: string | undefined;
  try {
    fromContext = tracingRuntime().contextTraceId();
  } catch {
    fromContext = undefined;
  }
  if (fromContext !== undefined && isTraceId(fromContext)) return fromContext;
  return scope?.fallbackTraceId ?? null;
}

/** The headers an outgoing call (or a job) made now would carry, or `null` outside any trace. */
export function outgoingTraceHeaders(): { traceparent: string; tracestate?: string } | null {
  const traceId = currentTraceId();
  if (traceId === null || !isTraceId(traceId)) return null;
  const scope = currentTraceScope();
  // The active OpenTelemetry span when there is one, else this request's or job's own span.
  const spanId = activeOtelSpan()?.spanId ?? scope?.spanId ?? newSpanId();
  const traceparent = formatTraceparent(traceId, spanId, scope?.flags);
  // The caller's tracestate belongs to the caller's trace: forwarded only within it.
  const tracestate =
    scope?.tracestate !== undefined &&
    (scope.upstreamTraceId === traceId || scope.fallbackTraceId === traceId)
      ? scope.tracestate
      : undefined;
  return tracestate === undefined ? { traceparent } : { traceparent, tracestate };
}

/** Span ids to record on the entry that represents the current unit of work. */
export function currentSpanLinks(): { spanId: string; parentSpanId: string | null } | null {
  const otel = activeOtelSpan();
  if (otel !== undefined) return { spanId: otel.spanId, parentSpanId: otel.parentSpanId };
  const scope = currentTraceScope();
  return scope === undefined ? null : { spanId: scope.spanId, parentSpanId: scope.parentSpanId };
}

/**
 * The scope an incoming request runs in, or `undefined` to run it as is: when OpenTelemetry has a
 * span for it (OTel continued the caller already), or there is no caller and the app did not
 * configure `propagation`.
 */
export function traceScopeForRequest(
  headers: Record<string, unknown>,
  runtime: Pick<TracingRuntime, 'incoming' | 'startTraces'> = tracingRuntime(),
): TraceScope | undefined {
  // Always a fresh scope per request: never inherit one from the connection's previous request.
  if (activeOtelSpan() !== undefined) return undefined;
  let parent: ReturnType<typeof parseTraceparent>;
  let tracestate: string | undefined;
  if (runtime.incoming) {
    parent = parseTraceparent(headers.traceparent);
    tracestate = parent === undefined ? undefined : parseTracestate(headers.tracestate);
  }
  if (parent === undefined && !runtime.startTraces) return undefined;
  return newTraceScope(parent, tracestate);
}

/** A trace carrier (`traceparent` / `tracestate`), as a queue job or a message holds it. */
export interface TraceCarrier {
  traceparent?: unknown;
  tracestate?: unknown;
}

/**
 * The tracing contract other Aviary packages read from `globalThis[TELESCOPE_TRACING_KEY]` without
 * importing telescope (the BullMQ watcher works with any core version). Present while a
 * `TelescopeModule` runs. Only grows.
 */
export interface TelescopeTracingSlot {
  /** Whether queue jobs carry the trace (`propagation.queue`). */
  readonly queue: boolean;
  /** The headers a job dispatched now carries, or `null` (outside a trace, or telescope's own work). */
  outgoing(): { traceparent: string; tracestate?: string } | null;
  /** Run `fn` continuing the trace in `carrier` (as is, when it carries none). */
  continueFrom<T>(carrier: TraceCarrier | undefined, fn: () => T): T;
  /** The span ids the entry of the current unit of work records (`spanId` / `parentSpanId`). */
  spanLinks(): { spanId: string; parentSpanId: string | null } | null;
}

/** Global slot of the {@link TelescopeTracingSlot}. */
export const TELESCOPE_TRACING_KEY = Symbol.for('@dudousxd/nestjs-telescope:tracing');

/** Publish the slot; returns the function that removes it (if still the published one). */
export function publishTracingSlot(): () => void {
  const published: TelescopeTracingSlot = {
    get queue() {
      return tracingRuntime().queue;
    },
    outgoing: () => (isTelescopeWork() ? null : outgoingTraceHeaders()),
    continueFrom: (carrier, fn) => {
      const parent = parseTraceparent(carrier?.traceparent);
      if (parent === undefined || !tracingRuntime().queue) return fn();
      return runInTraceScope(newTraceScope(parent, parseTracestate(carrier?.tracestate)), fn);
    },
    spanLinks: currentSpanLinks,
  };
  slot[TELESCOPE_TRACING_KEY] = published;
  return () => {
    if (slot[TELESCOPE_TRACING_KEY] === published) slot[TELESCOPE_TRACING_KEY] = undefined;
  };
}

/** Whether a `TelescopeModule` with tracing across apps runs in this process. */
export function isTracingActive(): boolean {
  return slot[RUNTIME_KEY] !== undefined;
}
