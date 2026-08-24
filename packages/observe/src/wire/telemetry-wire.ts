/**
 * The NestJS Observe ingest contract, as this package understands it.
 *
 * This is a PRIVATE, UNDOCUMENTED and UNVERSIONED API: it is not published in
 * `@nestjs/observe`'s npm tarball, has no OpenAPI description and carries no
 * stability promise. Everything here is transcribed from the encoders in
 * https://github.com/nestjs/observe (`src/encoders/*`), and the required/optional
 * split below was settled against the live collector rather than read off their
 * source. Four properties of the far side drive the shape of this file:
 *
 *  1. Keys are single letters. Long names exist only in `logs[]`.
 *  2. The collector validates with `forbidNonWhitelisted`, so ONE extra key
 *     fails the whole POST with a 400. Encoders must never spread a source
 *     object into a wire object.
 *  3. `snapshots[].st` is accepted by their own encoder but rejected by their
 *     collector, so it is absent here on purpose.
 *  4. Several fields their own agent can always fill are REQUIRED, not optional:
 *     every span needs `c` and `m` (their spans come from proxied provider
 *     methods, so a class and method always exist), and every snapshot needs
 *     `t`. Omitting any of them is a 400.
 */

/** `error` on a snapshot or a span. The only object on the wire with long keys besides a log. */
export interface WireError {
  cls?: string;
  message: string;
  stack?: string;
  tags?: Record<string, string | number | boolean>;
}

/**
 * One node of a snapshot's span tree. `so` (start offset, ms from the root's
 * start) is what lets the dashboard draw overlapping bars rather than a
 * strictly nested waterfall; `ch` is omitted on leaves because `ch: []`
 * everywhere roughly doubles the payload.
 */
export interface WireSpan {
  /** name */
  n: string;
  /** origin: `auto` for anything a watcher captured, `manual` for host-created spans. */
  o: 'auto' | 'manual';
  /** tags */
  t?: Record<string, string | number | boolean>;
  /** duration, ms */
  d?: number;
  /** error */
  e?: WireError;
  /**
   * className — half of what drives Observe's per-class timing view. Required
   * and capped at 255 by the collector, which rejects a span missing either
   * this or `m` with `must be a string`.
   */
  c: string;
  /** methodKey — the other half. Same requirement and cap. */
  m: string;
  /** children */
  ch?: WireSpan[];
  /** spanId */
  s?: string;
  /** startOffset, ms from the root span's start */
  so?: number;
}

/** `snapshots[].a` — request attributes. */
export interface WireSnapshotAttributes {
  /** method */
  m?: string;
  /** statusCode */
  sc?: number;
  /** originalUrl — the redacted URL, or a sanitized GraphQL document. */
  ou?: string;
}

/** One traced operation: an HTTP request, an RPC call, a GraphQL operation. */
export interface WireSnapshot {
  /** calledAt, ISO 8601 */
  ct: string;
  /** traceId */
  ti: string;
  /** duration, ms */
  d?: number;
  /** protocol */
  p?: string;
  /** operationId, e.g. `GET /orders` */
  op?: string;
  /** traces — the span tree. Required: the collector rejects a snapshot whose `t` is absent. */
  t: WireSpan[];
  /** attributes */
  a?: WireSnapshotAttributes;
  /** tags */
  tg?: Record<string, string | number | boolean>;
  /** error */
  e?: WireError;
  /** userId */
  u?: string;
}

/** One background job execution. Spans reuse {@link WireSpan}. */
export interface WireJob {
  /** id */
  i: string;
  /** traceId */
  ti?: string;
  /** name */
  n?: string;
  /** queueName */
  q?: string;
  /** status */
  s?: 'completed' | 'failed';
  /** calledAt, ISO 8601 */
  c?: string;
  /** duration, ms */
  d?: number;
  /** enqueuedAt, ISO 8601 */
  ea?: string;
  /** waitDuration, ms — time queued, excluding any configured delay. */
  wd?: number;
  /** attemptsMade */
  am?: number;
  /** maxAttempts */
  ma?: number;
  /** tags */
  tg?: Record<string, string | number | boolean>;
  /** traces */
  t?: WireSpan[];
  /** error */
  e?: WireError;
}

/**
 * `runtime` — one process snapshot per batch, last write wins on their side.
 * Byte counts for memory, microseconds for CPU, milliseconds for GC and lag.
 */
export interface WireRuntimeMetrics {
  /** cpu */
  c?: {
    /** user, µs */
    u: number;
    /** system, µs */
    s: number;
    /** percentageUsed, 0..100 over the sampling interval */
    p: number;
  };
  /** memory */
  m?: {
    /** rss */
    r: number;
    /** heapTotal */
    ht: number;
    /** heapUsed */
    hu: number;
    /** external */
    e: number;
    /** arrayBuffers */
    ab: number;
    /** percentageUsed, heapUsed over heapTotal */
    p: number;
  };
  /** gc */
  g?: {
    /** count */
    c: number;
    /** totalDuration, ms */
    td: number;
    /** breakdown by kind */
    b?: {
      /** minor */
      m: number;
      /** major */
      j: number;
      /** incremental */
      i: number;
    };
  };
  /** eventLoop */
  e?: {
    /** lag, ms */
    l: number;
    /** utilization, 0..1 */
    u: number;
  };
}

/**
 * One custom metric. Every numeric field is keyed by a label string rather than
 * being a scalar, so a metric carries all of its series in one record — see
 * {@link labelKey} for how that string is built. `iv` belongs to counters and
 * the quantile block to summaries; sending a field to the wrong type is a 400.
 */
export interface WireCustomMetric {
  /** name */
  n: string;
  /** type */
  t: 'counter' | 'gauge' | 'summary';
  /** value, per label key */
  v: Record<string, number>;
  /** tags */
  tg?: Record<string, string | number | boolean>;
  /** description */
  d?: string;
  /** label names this metric is keyed by */
  l?: string[];
  /** lastUpdated, ms since epoch */
  lu?: number;
  /** kind — gauges only */
  k?: 'additive' | 'ratio' | 'peak';
  /** increase since the last flush — counters only */
  iv?: Record<string, number>;
  /** p50 — summaries only */
  q50?: Record<string, number>;
  /** p95 — summaries only */
  q95?: Record<string, number>;
  /** p99 — summaries only */
  q99?: Record<string, number>;
  /** observation count — summaries only */
  ct?: Record<string, number>;
  /** total — summaries only */
  sm?: Record<string, number>;
  /** maximum — summaries only */
  mx?: Record<string, number>;
}

/**
 * The key every per-series number is filed under. Their agent stringifies the
 * label object with its keys sorted, so `{route,method}` and `{method,route}`
 * collapse to one series instead of two.
 */
export function labelKey(labels: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) sorted[key] = labels[key] as string;
  return JSON.stringify(sorted);
}

/** A forwarded log line. The one section that uses long key names. */
export interface WireLog {
  /** ms since epoch */
  timestamp: number;
  text: string;
  traceId?: string;
  spanId?: string;
  /** lowercased */
  level?: string;
  /** the Nest logger context, i.e. a class name */
  context?: string;
  attributes?: Record<string, unknown>;
}

/**
 * The POST body. `serviceId` is the only required field; every array is omitted
 * rather than sent empty, so a tick with nothing to report costs one small
 * request instead of a large empty one.
 */
export interface WireTelemetryBatch {
  serviceId: string;
  serviceVersion?: string;
  forwardLogs?: boolean;
  snapshots?: WireSnapshot[];
  jobs?: WireJob[];
  runtime?: WireRuntimeMetrics;
  custom?: WireCustomMetric[];
  logs?: WireLog[];
}

/** Path appended to the configured endpoint. */
export const TELEMETRY_PATH = '/applications/telemetry';

/** The hosted collector, and the only one that exists — there is no OSS build of it. */
export const DEFAULT_ENDPOINT = 'https://observe-api.nestjs.com';
