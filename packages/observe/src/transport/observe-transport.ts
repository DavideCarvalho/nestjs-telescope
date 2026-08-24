import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import type { ResolvedObserveOptions } from '../observe-options.js';
import { TELEMETRY_PATH, type WireTelemetryBatch } from '../wire/telemetry-wire.js';

/**
 * Compression is unconditional rather than size-gated: the collector answers a
 * body without `Content-Encoding: gzip` with a parse failure, so there is no
 * uncompressed mode to fall back to for small batches.
 *
 * Off the thread pool rather than `gzipSync` because `send()` runs on the flush
 * timer inside the host's process; a synchronous deflate of a full batch is
 * event-loop time stolen from the application being observed.
 */
const gzipAsync = promisify(gzip);

/** One attempt's ceiling. A collector that has not answered by now is not about to. */
const REQUEST_TIMEOUT_MS = 10_000;

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/** A collector asking for a longer pause than this is better served by dropping the batch. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Credentials do not become correct on their own, so a single definitive
 * rejection is enough to stop. The counter exists so the tolerance is one
 * constant to change, not a rewrite.
 */
const AUTH_FAILURES_BEFORE_DISABLE = 1;

/** How long the breaker stays quiet between reminders that telemetry is being dropped. */
const AUTH_RELOG_INTERVAL_MS = 3_600_000;

/** Statuses worth another attempt: the request may succeed unchanged later. */
const RETRYABLE_STATUSES = new Set([408, 429]);

const AUTH_STATUSES = new Set([401, 403]);

/** Enough of the collector's rejection to name the offending field, without pasting a page of HTML into the log. */
const ERROR_BODY_CHARS = 200;

export type ObserveTransportOptions = Pick<
  ResolvedObserveOptions,
  'endpoint' | 'appKey' | 'appSecret' | 'maxRetries' | 'fetch' | 'clock' | 'logger'
>;

/** Why nothing is arriving, in six numbers. Surfaced by the exporter's diagnostics. */
export interface ObserveTransportCounters {
  /** Batches the collector accepted. */
  readonly sent: number;
  /** `send()` calls that resolved false. */
  readonly failed: number;
  /** Individual attempts made beyond the first. */
  readonly retried: number;
  /** Subset of `failed` given up on without retrying: a rejected payload, bad credentials, an open breaker. */
  readonly droppedPermanent: number;
  /** HTTP status of the last response, whatever it was. */
  readonly lastStatus: number | null;
  /** `clock()` at the last failed attempt. */
  readonly lastErrorAt: number | null;
}

interface MutableCounters {
  sent: number;
  failed: number;
  retried: number;
  droppedPermanent: number;
  lastStatus: number | null;
  lastErrorAt: number | null;
}

/**
 * `FetchLike` deliberately describes only the three response members this
 * package depends on, so anything else has to be read as unknown. Reading
 * through here keeps that narrowing local instead of widening the shared type
 * for every implementation a host might inject.
 */
function readHeader(response: unknown, name: string): string | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const headers = (response as { headers?: unknown }).headers;
  if (typeof headers !== 'object' || headers === null) return undefined;

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = (getter as (headerName: string) => unknown).call(headers, name);
    return typeof value === 'string' ? value : undefined;
  }

  const value = (headers as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

/** `Retry-After` is either a delay in seconds or an HTTP date; both forms are in the wild. */
function parseRetryAfter(raw: string | undefined, now: number): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MS);
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}

/**
 * POSTs an encoded batch to Observe's ingest endpoint.
 *
 * Nothing here throws. A caller gets `false` and a counter; an escaping
 * rejection would be raised inside a Telescope extension hook, where the host
 * swallows it and the diagnostic is lost with it.
 */
export class ObserveTransport {
  private readonly url: string;
  private readonly tally: MutableCounters = {
    sent: 0,
    failed: 0,
    retried: 0,
    droppedPermanent: 0,
    lastStatus: null,
    lastErrorAt: null,
  };

  private consecutiveAuthFailures = 0;
  private authDisabled = false;
  private lastAuthLogAt = 0;
  private suppressedSinceLog = 0;

  constructor(private readonly options: ObserveTransportOptions) {
    this.url = `${options.endpoint}${TELEMETRY_PATH}`;
  }

  /** True once the breaker has opened: every further `send()` is a no-op. */
  get disabled(): boolean {
    return this.authDisabled;
  }

  /** A snapshot, so a caller cannot mutate the running totals. */
  get counters(): ObserveTransportCounters {
    return { ...this.tally };
  }

  /** Resolves true when the batch was accepted, false when it was given up on. */
  async send(batch: WireTelemetryBatch): Promise<boolean> {
    if (this.authDisabled) {
      this.noteSuppressedDrop();
      return false;
    }

    let body: Uint8Array;
    try {
      body = await gzipAsync(Buffer.from(JSON.stringify(batch), 'utf8'));
    } catch (error) {
      this.tally.lastErrorAt = this.options.clock();
      this.giveUp(`could not encode a batch: ${describe(error)}`);
      return false;
    }

    const attempts = Math.max(1, Math.floor(this.options.maxRetries));

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response: Awaited<ReturnType<ObserveTransportOptions['fetch']>>;

      try {
        response = await this.attempt(body);
      } catch (error) {
        this.tally.lastErrorAt = this.options.clock();
        if (attempt >= attempts) {
          this.giveUp(
            `gave up on POST ${TELEMETRY_PATH} after ${attempts} attempt(s): ${describe(error)}`,
          );
          return false;
        }
        await this.pause(this.backoffMs(attempt, null));
        continue;
      }

      this.tally.lastStatus = response.status;

      if (response.ok) {
        this.tally.sent++;
        this.consecutiveAuthFailures = 0;
        return true;
      }

      this.tally.lastErrorAt = this.options.clock();

      if (AUTH_STATUSES.has(response.status)) {
        await this.noteAuthFailure(response);
        return false;
      }

      // `forbidNonWhitelisted` on the far side means an unknown field is a 400,
      // and every later attempt with the same body earns the same 400.
      if (!isRetryableStatus(response.status)) {
        const detail = await readBodySnippet(response);
        this.tally.droppedPermanent++;
        this.giveUp(
          `POST ${TELEMETRY_PATH} rejected with ${response.status}; dropping the batch${detail}`,
        );
        return false;
      }

      if (attempt >= attempts) {
        this.giveUp(
          `POST ${TELEMETRY_PATH} still failing with ${response.status} after ${attempts} attempt(s); dropping the batch`,
        );
        return false;
      }

      await this.pause(
        this.backoffMs(
          attempt,
          parseRetryAfter(readHeader(response, 'retry-after'), this.options.clock()),
        ),
      );
    }

    return false;
  }

  private async attempt(
    body: Uint8Array,
  ): Promise<Awaited<ReturnType<ObserveTransportOptions['fetch']>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();

    try {
      return await this.options.fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'x-api-key': this.options.appKey,
          'x-api-secret': this.options.appSecret,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Equal jitter, so a fleet restarted together does not re-synchronise on the collector. */
  private backoffMs(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) return retryAfterMs;
    const capped = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    return capped / 2 + Math.random() * (capped / 2);
  }

  private pause(ms: number): Promise<void> {
    this.tally.retried++;
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Backoff must never be the reason a process refuses to exit.
      timer.unref?.();
    });
  }

  private async noteAuthFailure(
    response: Awaited<ReturnType<ObserveTransportOptions['fetch']>>,
  ): Promise<void> {
    this.tally.droppedPermanent++;
    this.tally.failed++;
    this.consecutiveAuthFailures++;

    const detail = await readBodySnippet(response);

    if (this.consecutiveAuthFailures >= AUTH_FAILURES_BEFORE_DISABLE) {
      this.authDisabled = true;
      this.lastAuthLogAt = this.options.clock();
      this.suppressedSinceLog = 0;
      this.options.logger.warn(
        `POST ${TELEMETRY_PATH} rejected with ${response.status}; credentials will not fix themselves, so telemetry export is now disabled${detail}`,
      );
      return;
    }

    this.options.logger.warn(`POST ${TELEMETRY_PATH} rejected with ${response.status}${detail}`);
  }

  /**
   * A day of silently dropped telemetry must not read as health, but Observe's
   * own SDK turns a wrong key into a per-flush 401 storm in the host's logs.
   * One line when the breaker opens, then one an hour with the running total.
   */
  private noteSuppressedDrop(): void {
    this.tally.failed++;
    this.tally.droppedPermanent++;
    this.suppressedSinceLog++;

    const now = this.options.clock();
    if (now - this.lastAuthLogAt < AUTH_RELOG_INTERVAL_MS) return;

    this.lastAuthLogAt = now;
    const dropped = this.suppressedSinceLog;
    this.suppressedSinceLog = 0;
    this.options.logger.warn(
      `telemetry export is still disabled after credentials were rejected on ${TELEMETRY_PATH}; ${dropped} batch(es) dropped since the last warning`,
    );
  }

  private giveUp(message: string): void {
    this.tally.failed++;
    this.options.logger.warn(message);
  }
}

async function readBodySnippet(
  response: Awaited<ReturnType<ObserveTransportOptions['fetch']>>,
): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (trimmed === '') return '';
    return `: ${trimmed.slice(0, ERROR_BODY_CHARS)}`;
  } catch {
    return '';
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
