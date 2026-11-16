// packages/core/src/tracing/scope.ts
//
// The trace a unit of work (an HTTP request, a queue job) belongs to when telescope keeps it rather
// than OpenTelemetry: the caller's trace id when there was a caller, and a span id of its own that
// the calls and jobs it makes name as their parent.
import { AsyncLocalStorage } from 'node:async_hooks';
import { type TraceParent, newSpanId, newTraceId } from './traceparent.js';

export interface TraceScope {
  /** The trace id a caller sent (`traceparent`, a job's trace context). `null`: no caller. */
  upstreamTraceId: string | null;
  /**
   * The trace id when there is no caller, no OpenTelemetry span and no nestjs-context trace id.
   * Minted with the scope.
   */
  fallbackTraceId: string;
  /** This unit of work's span id. */
  spanId: string;
  /** The caller's span id, or `null`. */
  parentSpanId: string | null;
  /** Trace flags to forward (`01` = sampled). */
  flags: string;
  /** The caller's `tracestate`, forwarded as is. */
  tracestate?: string;
}

// On a `Symbol.for()` slot so two copies of this package (and the BullMQ watcher) share one scope.
const SCOPE_KEY = Symbol.for('@dudousxd/nestjs-telescope:trace-scope');
const slot = globalThis as Record<symbol, unknown>;
const storage: AsyncLocalStorage<TraceScope> =
  (slot[SCOPE_KEY] as AsyncLocalStorage<TraceScope> | undefined) ??
  new AsyncLocalStorage<TraceScope>();
slot[SCOPE_KEY] = storage;

/** A scope continuing `parent` (a caller), or starting a new trace. */
export function newTraceScope(parent?: TraceParent, tracestate?: string): TraceScope {
  return {
    upstreamTraceId: parent?.traceId ?? null,
    fallbackTraceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    parentSpanId: parent?.spanId ?? null,
    flags: parent?.flags ?? '01',
    ...(tracestate !== undefined ? { tracestate } : {}),
  };
}

/** Run `fn` inside `scope`. */
export function runInTraceScope<T>(scope: TraceScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Make `scope` active for the rest of this async execution (the request middleware's way). */
export function enterTraceScope(scope: TraceScope): void {
  storage.enterWith(scope);
}

/** The active scope, or `undefined`. */
export function currentTraceScope(): TraceScope | undefined {
  return storage.getStore();
}
