import type { Entry } from '@dudousxd/nestjs-telescope';
import { DEFAULT_ENDPOINT } from './wire/telemetry-wire.js';

/** Injectable so specs can drive time without waiting, and so a host can share its own clock. */
export type Clock = () => number;

/** The subset of `fetch` this package uses. Swappable so specs never touch the network. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ExporterLogger {
  warn(message: string): void;
  debug?(message: string): void;
}

/**
 * Which payload sections to send. Observe bills per ingested record — a request,
 * job, error and log each count as one event, a span as a quarter — so this is
 * the knob that decides the invoice, and it is deliberately separate from
 * Telescope's own capture sampling: what is worth keeping locally for an hour is
 * not the same question as what is worth paying to retain for ninety days.
 */
export interface ObserveIncludeOptions {
  /** Requests as snapshots, carrying their exceptions. Default true. */
  requests?: boolean;
  /** Every other entry in a batch as a child span of its snapshot. Default true. */
  spans?: boolean;
  /** Queue and schedule runs as job snapshots. Default true. */
  jobs?: boolean;
  /** Log entries. Requires a paid Observe plan. Default true. */
  logs?: boolean;
  /** Process CPU, memory, GC and event-loop snapshots — Observe's Profiler is empty without them. Default true. */
  runtime?: boolean;
  /** Per-entry-type counters and duration summaries, counted before sampling. Default true. */
  metrics?: boolean;
}

export interface ObserveExporterOptions {
  /** Project API key. Scoped to an Observe project, not to one application. */
  appKey: string;
  /** Project API secret. */
  appSecret: string;
  /** Identifies this application inside the project. */
  serviceId: string;
  /** Powers Observe's release comparison. */
  serviceVersion?: string;
  /** Defaults to the hosted collector. */
  endpoint?: string;
  include?: ObserveIncludeOptions;
  /**
   * Last word on whether an entry leaves the process, applied after `include`
   * and before encoding. Return false to drop it.
   */
  filter?: (entry: Entry) => boolean;
  /**
   * Fraction of batches to forward, 0..1. A batch holding a failure is always
   * forwarded regardless — a sampled-away error is the one record you wanted.
   * Default 1.
   */
  sampleRate?: number;
  /**
   * How long to hold a batch open waiting for the rest of its entries. Telescope
   * flushes on a timer, so one request's entries routinely straddle two flushes;
   * emitting on first sight would ship a snapshot with no spans. Default 5000.
   */
  batchGraceMs?: number;
  /** Ceiling on batches held open at once, so a flood cannot grow the assembler without bound. Default 1000. */
  maxOpenBatches?: number;
  /** How often assembled batches are encoded and POSTed. Default 5000. */
  flushIntervalMs?: number;
  /** Ceiling on `snapshots` and on `jobs` per POST. Default 1000. */
  maxRecordsPerRequest?: number;
  /** Ceiling on `logs` per POST. Default 250. */
  maxLogsPerRequest?: number;
  /**
   * How often a process snapshot is taken. Kept far longer than the flush
   * interval because runtime metrics describe the process, not the traffic —
   * sampling them every flush would spend payload on six near-identical
   * readings a minute. Floored at 30s, matching what Observe's own agent allows.
   */
  runtimeIntervalMs?: number;
  /** Ceiling on distinct label combinations per custom metric. Default 1000. */
  maxSeriesPerMetric?: number;
  /**
   * Attempts per POST before the payload is dropped. Observe's own SDK does not
   * retry at all, so a brief collector outage silently costs it every batch in
   * flight; this package would rather spend a few seconds of backoff. Default 3.
   */
  maxRetries?: number;
  fetch?: FetchLike;
  clock?: Clock;
  logger?: ExporterLogger;
}

export interface ResolvedObserveOptions {
  appKey: string;
  appSecret: string;
  serviceId: string;
  serviceVersion: string | undefined;
  endpoint: string;
  include: Required<ObserveIncludeOptions>;
  filter: ((entry: Entry) => boolean) | undefined;
  sampleRate: number;
  batchGraceMs: number;
  maxOpenBatches: number;
  flushIntervalMs: number;
  maxRecordsPerRequest: number;
  maxLogsPerRequest: number;
  runtimeIntervalMs: number;
  maxSeriesPerMetric: number;
  maxRetries: number;
  fetch: FetchLike;
  clock: Clock;
  logger: ExporterLogger;
}

const MIN_RUNTIME_INTERVAL_MS = 30_000;

const DEFAULTS = {
  batchGraceMs: 5_000,
  runtimeIntervalMs: 60_000,
  maxSeriesPerMetric: 1_000,
  maxOpenBatches: 1_000,
  flushIntervalMs: 5_000,
  maxRecordsPerRequest: 1_000,
  maxLogsPerRequest: 250,
  maxRetries: 3,
  sampleRate: 1,
} as const;

const consoleLogger: ExporterLogger = {
  warn: (message) => console.warn(`[telescope-observe] ${message}`),
};

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Throws on missing credentials so a misconfiguration fails at boot rather than as a silent 401 an hour later. */
export function resolveObserveOptions(options: ObserveExporterOptions): ResolvedObserveOptions {
  for (const key of ['appKey', 'appSecret', 'serviceId'] as const) {
    if (typeof options[key] !== 'string' || options[key].trim() === '') {
      throw new Error(`[telescope-observe] \`${key}\` is required.`);
    }
  }

  const include = options.include ?? {};
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;

  return {
    appKey: options.appKey,
    appSecret: options.appSecret,
    serviceId: options.serviceId,
    serviceVersion: options.serviceVersion,
    endpoint: (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    include: {
      requests: include.requests ?? true,
      spans: include.spans ?? true,
      jobs: include.jobs ?? true,
      logs: include.logs ?? true,
      runtime: include.runtime ?? true,
      metrics: include.metrics ?? true,
    },
    filter: options.filter,
    sampleRate: Math.min(1, Math.max(0, options.sampleRate ?? DEFAULTS.sampleRate)),
    batchGraceMs: positive(options.batchGraceMs, DEFAULTS.batchGraceMs),
    maxOpenBatches: positive(options.maxOpenBatches, DEFAULTS.maxOpenBatches),
    flushIntervalMs: positive(options.flushIntervalMs, DEFAULTS.flushIntervalMs),
    maxRecordsPerRequest: positive(options.maxRecordsPerRequest, DEFAULTS.maxRecordsPerRequest),
    maxLogsPerRequest: positive(options.maxLogsPerRequest, DEFAULTS.maxLogsPerRequest),
    runtimeIntervalMs: Math.max(
      MIN_RUNTIME_INTERVAL_MS,
      positive(options.runtimeIntervalMs, DEFAULTS.runtimeIntervalMs),
    ),
    maxSeriesPerMetric: positive(options.maxSeriesPerMetric, DEFAULTS.maxSeriesPerMetric),
    maxRetries: positive(options.maxRetries, DEFAULTS.maxRetries),
    fetch: options.fetch ?? (globalFetch as FetchLike),
    clock: options.clock ?? Date.now,
    logger: options.logger ?? consoleLogger,
  };
}
