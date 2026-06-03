/**
 * Cache entries carry `content: { operation: 'get' | 'set', hit: boolean | null,
 * key: string }`. This module derives a small status pill from that content:
 * a green `HIT` / amber `MISS` for reads, and a neutral `SET` for writes.
 */

interface CacheContent {
  operation: 'get' | 'set';
  hit: boolean | null;
  key: string;
}

/** Narrow unknown entry content to the cache shape without casts. */
function isCacheContent(content: unknown): content is CacheContent {
  if (typeof content !== 'object' || content === null) return false;
  if (!('operation' in content) || !('hit' in content) || !('key' in content)) return false;
  const { operation, hit, key } = content;
  if (operation !== 'get' && operation !== 'set') return false;
  if (hit !== null && typeof hit !== 'boolean') return false;
  return typeof key === 'string';
}

export interface CacheBadgeInfo {
  label: 'HIT' | 'MISS' | 'SET';
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
  if (content.operation === 'set') {
    return { label: 'SET', className: `${PILL_BASE} border-zinc-700 text-zinc-300` };
  }
  if (content.hit === true) {
    return { label: 'HIT', className: `${PILL_BASE} border-emerald-500/40 text-emerald-300` };
  }
  if (content.hit === false) {
    return { label: 'MISS', className: `${PILL_BASE} border-amber-500/40 text-amber-300` };
  }
  return null;
}

/** Small cache hit/miss/set status pill; renders nothing for non-cache content. */
export function CacheBadge({ content }: { content: unknown }): JSX.Element | null {
  const badge = cacheBadge(content);
  if (badge === null) return null;
  return <span className={badge.className}>{badge.label}</span>;
}
