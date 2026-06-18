// packages/core/src/profiling/profiling-config.ts

/**
 * On-demand CPU flamegraph profiling. STRICTLY opt-in and OFF by default.
 *
 * When `enabled` is false (the default) the integration never constructs a
 * profiler, never requires `node:inspector`, and adds nothing to the request
 * hot path beyond a single boolean check.
 *
 * Two capture modes, which compose:
 *  - MANUAL: the headless API arms "profile the next N requests" / "profile this
 *    endpoint"; matching requests are captured until the budget is exhausted.
 *  - SAMPLED: `sampleRate` (0–1) auto-captures a fraction of requests. 0 (the
 *    default) disables sampling entirely so enabling the feature for manual
 *    triggers alone carries no per-request RNG cost beyond the gate.
 *
 * Profiling has REAL overhead, so concurrent captures are capped and a captured
 * request that finishes faster than `minDurationMs` is discarded.
 */
export interface ProfilingOptions {
  /** Master switch. Default `false`. Nothing below matters while this is false. */
  enabled?: boolean;
  /**
   * Fraction (0–1) of requests auto-captured. Default `0` (sampling off; manual
   * triggers still work). Errors/slow requests are NOT special-cased here —
   * sampling is uniform; use manual triggers for targeted captures.
   */
  sampleRate?: number;
  /**
   * Max simultaneous in-flight captures. A request that would exceed this is not
   * profiled (it runs untouched). Default `1` — profiling is expensive and
   * concurrent V8 profilers compound the overhead.
   */
  maxConcurrent?: number;
  /**
   * Captures whose wall time is below this are discarded (too short to be
   * meaningful, and the flamegraph would be near-empty). Default `0` (keep all).
   */
  minDurationMs?: number;
  /** V8 sampling interval in microseconds. Default 1000 (1ms). */
  samplingIntervalMicros?: number;
}

export interface ResolvedProfilingConfig {
  enabled: boolean;
  sampleRate: number;
  maxConcurrent: number;
  minDurationMs: number;
  samplingIntervalMicros: number;
}

/** Resolve + validate profiling options into a fully-defaulted config. */
export function resolveProfilingConfig(options?: ProfilingOptions): ResolvedProfilingConfig {
  const enabled = options?.enabled === true;
  const sampleRate = clamp01(options?.sampleRate ?? 0);
  const maxConcurrent = Math.max(1, Math.floor(options?.maxConcurrent ?? 1));
  const minDurationMs = Math.max(0, options?.minDurationMs ?? 0);
  const samplingIntervalMicros = Math.max(1, Math.floor(options?.samplingIntervalMicros ?? 1000));
  return { enabled, sampleRate, maxConcurrent, minDurationMs, samplingIntervalMicros };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
