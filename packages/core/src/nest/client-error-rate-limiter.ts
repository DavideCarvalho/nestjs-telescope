// packages/core/src/nest/client-error-rate-limiter.ts

/**
 * Default ceiling on the number of distinct IPs tracked at once. The limiter is
 * the only state the public client-error endpoint keeps, so it MUST stay bounded
 * — an attacker rotating source IPs (or sitting behind a large CGNAT/proxy pool)
 * could otherwise grow the map without limit. At the cap we evict the OLDEST
 * inserted IP, the one least likely to still be mid-burst, which is the right
 * bias for a short-window rate limiter.
 */
const DEFAULT_MAX_TRACKED_IPS = 10_000;

interface Bucket {
  /** Fractional tokens currently available (refills continuously). */
  tokens: number;
  /** Wall time (ms) the bucket was last refilled. */
  lastRefillMs: number;
}

/**
 * A bounded, in-memory, per-IP token-bucket rate limiter for the PUBLIC
 * client-error endpoint. Per-pod by design (no cross-process coordination): in a
 * multi-replica deployment the same client may get up to `perMinute` requests
 * PER POD — see the caveat in {@link ClientErrorsOptions.rateLimit}. The intent
 * is cheap abuse-dampening on a public surface, not a hard global quota.
 *
 * Each IP gets a bucket holding at most `perMinute` tokens that refills linearly
 * at `perMinute / 60_000` tokens per ms. A request consumes one token; an empty
 * bucket means "over the limit". The bucket map is capped (insertion-order
 * eviction of the oldest IP) so memory can't grow without bound.
 */
export class ClientErrorRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMinute: number;
  private readonly maxTrackedIps: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(options: {
    perMinute: number;
    maxTrackedIps?: number;
    /** Wall-clock seam (ms). Defaults to `Date.now`. */
    now?: () => number;
  }) {
    // Guard against a misconfigured zero/negative rate turning into a divide
    // that never refills; treat anything <= 0 as "allow 1/min" so the endpoint
    // still functions rather than locking out every caller forever.
    this.perMinute = options.perMinute > 0 ? options.perMinute : 1;
    this.maxTrackedIps = options.maxTrackedIps ?? DEFAULT_MAX_TRACKED_IPS;
    this.refillPerMs = this.perMinute / 60_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Try to spend one token for `ip`. Returns `true` when the request is allowed
   * (a token was available and consumed), `false` when the bucket is empty (over
   * the limit). Refills the bucket continuously based on elapsed time so the
   * effective rate is exactly `perMinute` without a coarse fixed window.
   */
  tryConsume(ip: string): boolean {
    const nowMs = this.now();
    const existing = this.buckets.get(ip);
    if (existing === undefined) {
      // First request from this IP: start full, immediately spend one token.
      this.insert(ip, { tokens: this.perMinute - 1, lastRefillMs: nowMs });
      return true;
    }
    const elapsedMs = nowMs - existing.lastRefillMs;
    const refilled = Math.min(this.perMinute, existing.tokens + elapsedMs * this.refillPerMs);
    existing.lastRefillMs = nowMs;
    if (refilled < 1) {
      existing.tokens = refilled;
      return false;
    }
    existing.tokens = refilled - 1;
    return true;
  }

  /** Number of tracked IPs (test/observability seam). */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Insert a fresh bucket, evicting the oldest tracked IP first when at the cap.
   * `Map` iterates in insertion order, so the first key is the oldest inserted.
   */
  private insert(ip: string, bucket: Bucket): void {
    while (this.buckets.size >= this.maxTrackedIps) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    this.buckets.set(ip, bucket);
  }
}

export { DEFAULT_MAX_TRACKED_IPS };
