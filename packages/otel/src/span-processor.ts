// packages/otel/src/span-processor.ts
import type {
  CoveredOperation,
  RecordInput,
  SpanContent,
  SpanKindName,
  TelescopeRuntime,
} from '@dudousxd/nestjs-telescope';

/**
 * `telescopeSpanProcessor()` brings the spans your OpenTelemetry instrumentation produces
 * (pg, outgoing http, the Nest router, your own `tracer.startActiveSpan(...)` calls…) into
 * Telescope as `span` entries, so they show in the trace waterfall next to Telescope's own
 * entries.
 *
 * Structural on purpose: this module imports nothing at runtime, neither `@opentelemetry/*`
 * nor Telescope. The SDK hands spans over through the interfaces below and the booted Telescope
 * is read from a global slot, so the OpenTelemetry bootstrap file can build the processor
 * before Nest and the instrumented libraries load.
 *
 * - Where a Telescope watcher records the same operation (incoming requests, SQL, redis
 *   commands, `fetch` and axios calls through the http-client watcher), the watcher stays the
 *   source and the OTel span is skipped, together with the driver spans under it. With that
 *   watcher off, the span comes through. When sampling can drop the watcher's entries, the span
 *   is held until the watcher records the call and comes through only if the entry was dropped.
 * - Spans Telescope emits itself, its own storage work and requests to the dashboard are
 *   skipped.
 * - Ingestion goes through the recorder like any watcher: redaction, sampling and the overload
 *   guard apply. A trace contributes at most `maxSpansPerTrace` spans and attributes are capped.
 */

/** OpenTelemetry `HrTime`: seconds + nanoseconds. */
type HrTime = [number, number];

/** The slice of an SDK `ReadableSpan` the processor reads. */
export interface ReadableSpanLike {
  readonly name: string;
  readonly kind: number;
  spanContext(): { traceId: string; spanId: string };
  readonly parentSpanContext?: { spanId: string } | undefined;
  readonly startTime: HrTime;
  readonly duration: HrTime;
  readonly status: { code: number; message?: string | undefined };
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events?: ReadonlyArray<{
    name: string;
    attributes?: Readonly<Record<string, unknown>> | undefined;
  }>;
  readonly instrumentationScope?: { name: string; version?: string | undefined };
}

/** The slice of an SDK `Span` passed to `onStart`. */
export interface StartedSpanLike {
  readonly name: string;
  readonly kind: number;
  spanContext(): { traceId: string; spanId: string };
  readonly parentSpanContext?: { spanId: string } | undefined;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly instrumentationScope?: { name: string; version?: string | undefined };
}

/** What the SDK expects in `spanProcessors`. */
export interface TelescopeSpanProcessor {
  onStart(span: StartedSpanLike, parentContext: unknown): void;
  onEnd(span: ReadableSpanLike): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Options for {@link telescopeSpanProcessor}. */
export interface TelescopeSpanProcessorOptions {
  /** Return `true` to keep a span out of Telescope. Runs after the built-in skips. */
  ignore?: (span: ReadableSpanLike) => boolean;
  /** Most spans one trace contributes. The rest of that trace is dropped. Default `200`. */
  maxSpansPerTrace?: number;
  /** Most attributes kept per span. Default `64`. */
  maxAttributes?: number;
  /** Longest string attribute value kept; longer ones are cut. Default `2048`. */
  maxAttributeLength?: number;
}

const RUNTIME_KEY = Symbol.for('@dudousxd/nestjs-telescope:runtime');
const SPAN_PROCESSOR_KEY = Symbol.for('@dudousxd/nestjs-telescope:span-processor');
const COVERED_OUTCOME_KEY = Symbol.for('@dudousxd/nestjs-telescope:covered-outcome');
const SPAN_ENTRY_TYPE = 'span';

const KIND_NAMES: readonly SpanKindName[] = [
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
];
const SPAN_KIND_SERVER = 1;
const SPAN_KIND_CLIENT = 2;
const STATUS_NAMES = ['unset', 'ok', 'error'] as const;

/** Scopes Telescope emits its own spans under (`TelescopeOtelExporter`). */
const TELESCOPE_SCOPES = new Set(['telescope', '@dudousxd/nestjs-telescope-otel']);

/**
 * Instrumentations a Telescope watcher already covers, by scope name. `kind` narrows the match
 * (the http instrumentation makes server and client spans; only the server side is the request
 * middleware's). `leaf` marks operations whose child spans are driver internals: those are
 * skipped with them. Outgoing http is matched per call instead (see `isCoveredCall`).
 */
const COVERED: ReadonlyArray<{
  scope: string;
  operation: CoveredOperation;
  kind?: number;
  leaf: boolean;
}> = [
  {
    scope: '@opentelemetry/instrumentation-http',
    kind: SPAN_KIND_SERVER,
    operation: 'request',
    leaf: false,
  },
  ...[
    '@opentelemetry/instrumentation-pg',
    '@opentelemetry/instrumentation-mysql',
    '@opentelemetry/instrumentation-mysql2',
    '@opentelemetry/instrumentation-tedious',
    '@opentelemetry/instrumentation-oracledb',
    '@opentelemetry/instrumentation-knex',
    'prisma',
  ].map((scope) => ({ scope, operation: 'query' as const, leaf: true })),
  ...[
    '@opentelemetry/instrumentation-ioredis',
    '@opentelemetry/instrumentation-redis',
    '@opentelemetry/instrumentation-redis-4',
  ].map((scope) => ({ scope, operation: 'redis' as const, leaf: true })),
];

const HTTP_SCOPE = '@opentelemetry/instrumentation-http';
const UNDICI_SCOPE = '@opentelemetry/instrumentation-undici';

/** An outgoing http span: `fetch` (undici) or `http.request` (axios and most SDKs). */
function isHttpClientSpan(span: StartedSpanLike): boolean {
  const scope = scopeOf(span);
  return scope === UNDICI_SCOPE || (scope === HTTP_SCOPE && span.kind === SPAN_KIND_CLIENT);
}

const MAX_EVENTS = 16;
/** How many traces / span ids the processor remembers at once (oldest forgotten first). */
const MAX_TRACKED = 4096;
/** How long a held span waits for its watcher's sampling decision before it is shown. */
const HOLD_MS = 2_000;
/** How long a watcher's sampling decision waits for its span (a `fetch` body can outlive it). */
const OUTCOME_MS = 60_000;
const SWEEP_MS = 500;

/** A `Set` that forgets its oldest member past `limit`. */
class BoundedSet<T> {
  private readonly items = new Set<T>();
  constructor(private readonly limit: number) {}
  add(value: T): void {
    this.items.delete(value);
    this.items.add(value);
    if (this.items.size > this.limit) {
      const oldest = this.items.values().next();
      if (oldest.done !== true) this.items.delete(oldest.value);
    }
  }
  has(value: T): boolean {
    return this.items.has(value);
  }
  delete(value: T): void {
    this.items.delete(value);
  }
}

/** The booted Telescope, or `undefined` before it booted. */
function runtime(): TelescopeRuntime | undefined {
  const value = (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] as
    | TelescopeRuntime
    | undefined;
  return value?.record != null ? value : undefined;
}

function scopeOf(span: { instrumentationScope?: { name: string } | undefined }): string {
  return span.instrumentationScope?.name ?? 'unknown';
}

function hrToMs(time: HrTime): number {
  return time[0] * 1000 + time[1] / 1e6;
}

/** Whether `path` is `prefix` or below it (`/telescope` covers `/telescope/api`, not `/telescopes`). */
function isUnder(path: string, prefix: string): boolean {
  const query = path.indexOf('?');
  const bare = query === -1 ? path : path.slice(0, query);
  if (bare === prefix) return true;
  return bare.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

function serverPath(attributes: Readonly<Record<string, unknown>>): string | null {
  const path = attributes['url.path'] ?? attributes['http.target'];
  return typeof path === 'string' ? path : null;
}

/** Copy at most `max` attributes, cutting long strings. */
function capAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
  max: number,
  maxLength: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (attributes === undefined) return out;
  let count = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (count >= max) break;
    if (value === undefined) continue;
    out[key] =
      typeof value === 'string' && value.length > maxLength
        ? `${value.slice(0, maxLength)}…`
        : value;
    count++;
  }
  return out;
}

/**
 * Build the span processor. Add it next to your exporter's processor in the NodeSDK:
 *
 * ```ts
 * import { NodeSDK } from '@opentelemetry/sdk-node';
 * import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
 * import { telescopeSpanProcessor } from '@dudousxd/nestjs-telescope-otel/span-processor';
 *
 * new NodeSDK({
 *   spanProcessors: [new BatchSpanProcessor(exporter), telescopeSpanProcessor()],
 * }).start();
 * ```
 */
export function telescopeSpanProcessor(
  options: TelescopeSpanProcessorOptions = {},
): TelescopeSpanProcessor {
  const maxSpansPerTrace = Math.max(1, options.maxSpansPerTrace ?? 200);
  const maxAttributes = Math.max(0, options.maxAttributes ?? 64);
  const maxAttributeLength = Math.max(16, options.maxAttributeLength ?? 2048);

  (globalThis as Record<symbol, unknown>)[SPAN_PROCESSOR_KEY] = true;

  /** Spans skipped at start whose descendants are skipped too (driver internals, own work). */
  const skippedSpans = new BoundedSet<string>(MAX_TRACKED);
  /** Traces of requests to the dashboard. */
  const dashboardTraces = new BoundedSet<string>(MAX_TRACKED);
  /** Spans held at start, by the operation whose watcher decides on them. */
  const heldSpans = new Map<string, CoveredOperation>();
  /** Spans ingested so far, per trace. */
  const perTrace = new Map<string, number>();

  function coveredBy(rt: TelescopeRuntime, span: StartedSpanLike | ReadableSpanLike) {
    const scope = scopeOf(span);
    return COVERED.find(
      (c) =>
        c.scope === scope &&
        (c.kind === undefined || c.kind === span.kind) &&
        (rt.covered.get(c.operation) ?? 0) > 0,
    );
  }

  function shouldSkip(rt: TelescopeRuntime, span: ReadableSpanLike): boolean {
    const { traceId, spanId } = span.spanContext();
    if (skippedSpans.has(spanId)) {
      skippedSpans.delete(spanId);
      return true;
    }
    if (dashboardTraces.has(traceId)) {
      if (span.kind === SPAN_KIND_SERVER && span.parentSpanContext === undefined) {
        dashboardTraces.delete(traceId);
      }
      return true;
    }
    if (TELESCOPE_SCOPES.has(scopeOf(span))) return true;
    if (coveredBy(rt, span) !== undefined) return true;
    if (rt.isTelescopeWork()) return true;
    return options.ignore?.(span) === true;
  }

  function countAgainstTrace(traceId: string): boolean {
    const seen = perTrace.get(traceId) ?? 0;
    if (seen >= maxSpansPerTrace) return false;
    perTrace.delete(traceId);
    perTrace.set(traceId, seen + 1);
    if (perTrace.size > MAX_TRACKED) {
      const oldest = perTrace.keys().next();
      if (oldest.done !== true) perTrace.delete(oldest.value);
    }
    return true;
  }

  function ingest(rt: TelescopeRuntime, span: ReadableSpanLike): void {
    if (rt.record === null || rt.isPaused()) return;
    if (dashboardTraces.has(span.spanContext().traceId)) return;
    if (options.ignore?.(span) === true) return;
    if (!countAgainstTrace(span.spanContext().traceId)) return;
    rt.record(toInput(span));
  }

  // ── Sampled coverage ─────────────────────────────────────────────────────
  // When sampling can drop a covering watcher's entries, its spans are held instead of skipped,
  // and paired with the watcher's sampling decision for the same operation in the same trace:
  // a kept entry drops the span, a dropped entry lets it through. Calls within one trace pair
  // in the order they finish. A span whose decision never arrives (a call the watcher doesn't
  // see) comes through after `HOLD_MS`.

  type Pending =
    | { kind: 'span'; span: ReadableSpanLike; at: number }
    | { kind: 'outcome'; kept: boolean; at: number };
  /** Held spans or unmatched decisions, per `operation + trace`. One kind at a time per key. */
  const pending = new Map<string, Pending[]>();
  let pendingCount = 0;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const pendingKey = (operation: CoveredOperation, traceKey: string) => `${operation}|${traceKey}`;

  function hold(operation: CoveredOperation, span: ReadableSpanLike): void {
    // The watcher records in the caller's context: the trace of the span's parent, if any.
    const traceKey = span.parentSpanContext === undefined ? '' : span.spanContext().traceId;
    const key = pendingKey(operation, traceKey);
    const queue = pending.get(key);
    const head = queue?.[0];
    if (head?.kind === 'outcome') {
      shift(key);
      if (!head.kept) release(span);
      return;
    }
    push(key, { kind: 'span', span, at: Date.now() });
  }

  const settle = (operation: CoveredOperation, traceKey: string, kept: boolean): void => {
    try {
      const key = pendingKey(operation, traceKey);
      const head = pending.get(key)?.[0];
      if (head?.kind === 'span') {
        shift(key);
        if (!kept) release(head.span);
        return;
      }
      push(key, { kind: 'outcome', kept, at: Date.now() });
    } catch {
      // Observability never breaks the instrumented code.
    }
  };

  function release(span: ReadableSpanLike): void {
    const rt = runtime();
    if (rt !== undefined) ingest(rt, span);
  }

  function push(key: string, item: Pending): void {
    const queue = pending.get(key);
    if (queue === undefined) pending.set(key, [item]);
    else queue.push(item);
    pendingCount++;
    if (pendingCount > MAX_TRACKED) evictOldest();
    startSweep();
  }

  function shift(key: string): Pending | undefined {
    const queue = pending.get(key);
    const item = queue?.shift();
    if (item !== undefined) pendingCount--;
    if (queue !== undefined && queue.length === 0) pending.delete(key);
    return item;
  }

  function evictOldest(): void {
    const first = pending.keys().next();
    if (first.done === true) return;
    const item = shift(first.value);
    if (item?.kind === 'span') release(item.span);
  }

  function sweep(): void {
    const now = Date.now();
    for (const key of [...pending.keys()]) {
      for (;;) {
        const head = pending.get(key)?.[0];
        if (head === undefined) break;
        const ttl = head.kind === 'span' ? HOLD_MS : OUTCOME_MS;
        if (now - head.at < ttl) break;
        shift(key);
        if (head.kind === 'span') release(head.span);
      }
    }
    if (pendingCount === 0) stopSweep();
  }

  function startSweep(): void {
    if (sweepTimer !== null) return;
    sweepTimer = setInterval(() => {
      try {
        sweep();
      } catch {
        // Observability never breaks the instrumented code.
      }
    }, SWEEP_MS);
    sweepTimer.unref?.();
  }

  function stopSweep(): void {
    if (sweepTimer === null) return;
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  const outcomeSlot = globalThis as Record<symbol, unknown>;
  outcomeSlot[COVERED_OUTCOME_KEY] = settle;

  function toInput(span: ReadableSpanLike): RecordInput<SpanContent> {
    const { traceId, spanId } = span.spanContext();
    const scope = scopeOf(span);
    const kind = KIND_NAMES[span.kind] ?? 'internal';
    const status = STATUS_NAMES[span.status.code] ?? 'unset';
    const failed = status === 'error';
    return {
      type: SPAN_ENTRY_TYPE,
      familyHash: `${scope}:${span.name}`,
      tags: [`scope:${scope}`, `kind:${kind}`, ...(failed ? ['failed'] : [])],
      durationMs: Math.max(0, hrToMs(span.duration)),
      startedAt: new Date(hrToMs(span.startTime)),
      traceId,
      spanId,
      content: {
        name: span.name,
        kind,
        scope,
        spanId,
        parentSpanId: span.parentSpanContext?.spanId ?? null,
        status,
        statusMessage: span.status.message ?? null,
        failed,
        attributes: capAttributes(span.attributes, maxAttributes, maxAttributeLength),
        events: (span.events ?? []).slice(0, MAX_EVENTS).map((event) => ({
          name: event.name,
          attributes: capAttributes(event.attributes, maxAttributes, maxAttributeLength),
        })),
      },
    };
  }

  return {
    onStart(span) {
      try {
        const rt = runtime();
        if (rt === undefined) return;
        const { traceId, spanId } = span.spanContext();
        const parentId = span.parentSpanContext?.spanId;
        if (parentId !== undefined && (skippedSpans.has(parentId) || heldSpans.has(parentId))) {
          skippedSpans.add(spanId);
          return;
        }
        if (rt.isTelescopeWork()) {
          skippedSpans.add(spanId);
          return;
        }
        const covered = coveredBy(rt, span);
        let operation: CoveredOperation | undefined;
        if (covered?.leaf === true) operation = covered.operation;
        // An outgoing call the http-client watcher records: its http_client entry has it.
        else if (isHttpClientSpan(span) && rt.isCoveredCall()) operation = 'http-client';
        if (operation !== undefined) {
          // Sampling may drop the watcher's entry: hold the span until the watcher decides.
          if (rt.isSampled?.(operation) === true) {
            heldSpans.set(spanId, operation);
            if (heldSpans.size > MAX_TRACKED) {
              const oldest = heldSpans.keys().next();
              if (oldest.done !== true) heldSpans.delete(oldest.value);
            }
          } else {
            skippedSpans.add(spanId);
          }
          return;
        }
        if (span.kind === SPAN_KIND_SERVER && rt.selfPath !== null) {
          const path = serverPath(span.attributes);
          if (path !== null && isUnder(path, rt.selfPath)) dashboardTraces.add(traceId);
        }
      } catch {
        // Observability never breaks the instrumented code.
      }
    },

    onEnd(span) {
      try {
        const rt = runtime();
        if (rt === undefined || rt.record === null) return;
        const operation = heldSpans.get(span.spanContext().spanId);
        if (operation !== undefined) {
          heldSpans.delete(span.spanContext().spanId);
          hold(operation, span);
          return;
        }
        if (rt.isPaused()) return;
        if (shouldSkip(rt, span)) return;
        ingest(rt, span);
      } catch {
        // Observability never breaks the instrumented code.
      }
    },

    forceFlush: () => Promise.resolve(),
    shutdown() {
      if (outcomeSlot[COVERED_OUTCOME_KEY] === settle) delete outcomeSlot[COVERED_OUTCOME_KEY];
      pending.clear();
      pendingCount = 0;
      stopSweep();
      return Promise.resolve();
    },
  };
}
