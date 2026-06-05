// packages/core/src/ai/diagnosis-cache.ts

/** Default cap on cached diagnoses. Bounds memory regardless of error variety. */
const DEFAULT_MAX_ENTRIES = 500;

/** Default time a cached diagnosis stays fresh: 24h. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  markdown: string;
  storedAt: number;
}

/**
 * Bounded, TTL'd, per-pod cache of AI diagnoses keyed by exception `familyHash`.
 * A family is diagnosed ONCE then served from here, so neither the operator
 * clicking "Diagnose" repeatedly nor auto-mode re-running on every occurrence
 * burns model tokens.
 *
 * PER-POD caveat: this is in-process memory. In a multi-replica deployment each
 * pod caches independently, so the same family may be diagnosed up to once per
 * pod. That's the same per-replica trade-off the `new-exception` tracker makes
 * (documented), and it keeps the hot path a plain map lookup with no shared store.
 *
 * Eviction is insertion-order (`Map` iteration): at the cap the OLDEST inserted
 * entry is dropped. TTL is checked lazily on read (an expired hit is a miss and
 * is deleted), so stale entries don't linger as false "cached" results.
 */
export class DiagnosisCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options?: { maxEntries?: number; ttlMs?: number; now?: () => number }) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options?.now ?? Date.now;
  }

  /**
   * Return the cached markdown for `familyHash`, or `null` on a miss / expiry.
   * An expired entry is deleted so it can't be reported as cached.
   */
  get(familyHash: string): string | null {
    const entry = this.entries.get(familyHash);
    if (entry === undefined) return null;
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(familyHash);
      return null;
    }
    return entry.markdown;
  }

  /** Store (or refresh) the diagnosis for `familyHash`, evicting if over cap. */
  set(familyHash: string, markdown: string): void {
    // Delete-then-set so a refreshed family moves to the END of insertion order,
    // keeping genuinely-oldest entries at the front for eviction.
    this.entries.delete(familyHash);
    this.entries.set(familyHash, { markdown, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Whether a fresh diagnosis is cached for `familyHash` (TTL-aware). */
  has(familyHash: string): boolean {
    return this.get(familyHash) !== null;
  }

  /** Number of live entries (test/observability seam; does not evict expired). */
  get size(): number {
    return this.entries.size;
  }
}

export {
  DEFAULT_MAX_ENTRIES as DEFAULT_DIAGNOSIS_CACHE_MAX,
  DEFAULT_TTL_MS as DEFAULT_DIAGNOSIS_TTL_MS,
};
