/**
 * Cache entries carry `content: { operation, hit, key, tier?, stale?, ... }`. This
 * module derives a small status pill: green `HIT` / amber `MISS` for reads, neutral
 * `SET`, and `DEL`/`CLEAR` for writes. A grace-served (`stale`) hit reads amber to
 * stand out from a fresh hit; a `tier` (e.g. l1/l2) is appended when present.
 */

interface CacheContent {
  operation: 'get' | 'set' | 'delete' | 'clear';
  hit: boolean | null;
  key: string;
  tier?: string;
  stale?: boolean;
}

const OPERATIONS = new Set(['get', 'set', 'delete', 'clear']);

/** Narrow unknown entry content to the cache shape without casts. */
function isCacheContent(content: unknown): content is CacheContent {
  if (typeof content !== 'object' || content === null) return false;
  if (!('operation' in content) || !('hit' in content) || !('key' in content)) return false;
  const { operation, hit, key } = content;
  if (typeof operation !== 'string' || !OPERATIONS.has(operation)) return false;
  if (hit !== null && typeof hit !== 'boolean') return false;
  return typeof key === 'string';
}

export interface CacheBadgeInfo {
  label: string;
  className: string;
}

const PILL_BASE = 'rounded border px-1.5 py-0.5 text-[10px] font-medium';

/**
 * Pure mapping from entry content to a cache pill descriptor; `null` for any
 * non-cache or unrecognized content. Mirrors the bordered-pill token style used
 * by the queue action buttons.
 */
export function cacheBadge(content: unknown): CacheBadgeInfo | null {
  if (!isCacheContent(content)) return null;
  const tierSuffix = typeof content.tier === 'string' ? ` ${content.tier.toUpperCase()}` : '';
  if (content.operation === 'set') {
    return { label: `SET${tierSuffix}`, className: `${PILL_BASE} border-zinc-700 text-zinc-300` };
  }
  if (content.operation === 'delete') {
    return { label: 'DEL', className: `${PILL_BASE} border-zinc-700 text-zinc-400` };
  }
  if (content.operation === 'clear') {
    return { label: 'CLEAR', className: `${PILL_BASE} border-zinc-700 text-zinc-400` };
  }
  if (content.hit === true) {
    // A grace-period (stale) hit is amber so it's distinguishable from a fresh hit.
    const stale = content.stale === true;
    return {
      label: `${stale ? 'HIT·STALE' : 'HIT'}${tierSuffix}`,
      className: `${PILL_BASE} ${
        stale ? 'border-amber-500/40 text-amber-300' : 'border-emerald-500/40 text-emerald-300'
      }`,
    };
  }
  if (content.hit === false) {
    return {
      label: `MISS${tierSuffix}`,
      className: `${PILL_BASE} border-amber-500/40 text-amber-300`,
    };
  }
  return null;
}

/** Small cache hit/miss/set status pill; renders nothing for non-cache content. */
export function CacheBadge({ content }: { content: unknown }): JSX.Element | null {
  const badge = cacheBadge(content);
  if (badge === null) return null;
  return <span className={badge.className}>{badge.label}</span>;
}
