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
 *   commands, `fetch` calls through the http-client watcher), the watcher stays the source and
 *   the OTel span is skipped, together with the driver spans under it. With that watcher off,
 *   the span comes through.
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
const SPAN_ENTRY_TYPE = 'span';

const KIND_NAMES: readonly SpanKindName[] = [
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
];
const SPAN_KIND_SERVER = 1;
const STATUS_NAMES = ['unset', 'ok', 'error'] as const;

/** Scopes Telescope emits its own spans under (`TelescopeOtelExporter`). */
const TELESCOPE_SCOPES = new Set(['telescope', '@dudousxd/nestjs-telescope-otel']);

/**
 * Instrumentations a Telescope watcher already covers, by scope name. `kind` narrows the match
 * (the http instrumentation makes server and client spans; only the server side is the request
 * middleware's). `leaf` marks operations whose child spans are driver internals: those are
 * skipped with them. Outgoing `fetch` is matched per call instead (see `isCoveredCall`).
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
    '@prisma/instrumentation',
    'prisma',
  ].map((scope) => ({ scope, operation: 'query' as const, leaf: true })),
  ...[
    '@opentelemetry/instrumentation-ioredis',
    '@opentelemetry/instrumentation-redis',
    '@opentelemetry/instrumentation-redis-4',
  ].map((scope) => ({ scope, operation: 'redis' as const, leaf: true })),
];

const UNDICI_SCOPE = '@opentelemetry/instrumentation-undici';
const MAX_EVENTS = 16;
/** How many traces / span ids the processor remembers at once (oldest forgotten first). */
const MAX_TRACKED = 4096;

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
        if (parentId !== undefined && skippedSpans.has(parentId)) {
          skippedSpans.add(spanId);
          return;
        }
        if (rt.isTelescopeWork()) {
          skippedSpans.add(spanId);
          return;
        }
        if (coveredBy(rt, span)?.leaf === true) {
          skippedSpans.add(spanId);
          return;
        }
        // A `fetch` the http-client watcher records: its http_client entry has it.
        if (scopeOf(span) === UNDICI_SCOPE && rt.isCoveredCall()) {
          skippedSpans.add(spanId);
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
        if (rt === undefined || rt.record === null || rt.isPaused()) return;
        if (shouldSkip(rt, span)) return;
        if (!countAgainstTrace(span.spanContext().traceId)) return;
        rt.record(toInput(span));
      } catch {
        // Observability never breaks the instrumented code.
      }
    },

    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}
