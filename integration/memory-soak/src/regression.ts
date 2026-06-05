// integration/memory-soak/src/regression.ts
//
// Ordinary-least-squares slope of heapUsed-over-time samples, expressed in
// bytes/min. A real retention leak shows a clear positive slope; bounded churn
// settles near zero once GC runs before each sample.

export interface HeapSample {
  /** Milliseconds since the measured window started. */
  elapsedMs: number;
  /** process.memoryUsage().heapUsed after an explicit global.gc(). */
  heapUsedBytes: number;
}

export interface SlopeResult {
  /** Least-squares slope in bytes per minute. */
  bytesPerMin: number;
  /** First post-warmup heapUsed, bytes. */
  firstBytes: number;
  /** Last heapUsed, bytes. */
  lastBytes: number;
  /** Net growth across the window, bytes. */
  deltaBytes: number;
  /** Number of samples used. */
  samples: number;
}

/**
 * OLS slope of heapUsedBytes against elapsed minutes. Returns 0 when there are
 * fewer than two samples or the x-variance is zero (degenerate window).
 */
export function computeSlope(samples: HeapSample[]): SlopeResult {
  const n = samples.length;
  const first = samples[0];
  const last = samples[n - 1];
  const firstBytes = first?.heapUsedBytes ?? 0;
  const lastBytes = last?.heapUsedBytes ?? 0;
  const base: SlopeResult = {
    bytesPerMin: 0,
    firstBytes,
    lastBytes,
    deltaBytes: lastBytes - firstBytes,
    samples: n,
  };
  if (n < 2) return base;

  let sumX = 0;
  let sumY = 0;
  for (const sample of samples) {
    sumX += sample.elapsedMs / 60_000;
    sumY += sample.heapUsedBytes;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const dx = sample.elapsedMs / 60_000 - meanX;
    numerator += dx * (sample.heapUsedBytes - meanY);
    denominator += dx * dx;
  }
  if (denominator === 0) return base;

  return { ...base, bytesPerMin: numerator / denominator };
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function formatSlope(bytesPerMin: number): string {
  const mbPerMin = bytesPerMin / (1024 * 1024);
  return `${mbPerMin >= 0 ? '+' : ''}${mbPerMin.toFixed(2)} MB/min`;
}
