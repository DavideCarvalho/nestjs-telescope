/**
 * Cache entries carry `content: { operation, hit, key, tier?, stale?, ... }`. This
 * module derives a small status pill: `HIT` reads `--good`, `MISS` reads `--warn`,
 * and `SET`/`DEL`/`CLEAR` are neutral. A grace-served (`stale`) hit reads warn to
 * stand out from a fresh hit; a `tier` (e.g. l1/l2) is appended when present.
 */
import { Badge, type BadgeProps, badgeVariants } from '../ui/index.js';

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
  /**
   * Semantic role, not a colour: which `Badge` variant renders this pill. The
   * hue behind it comes from the Aviary status tokens, so it themes with the
   * console. Prefer this over {@link CacheBadgeInfo.className} in new code.
   */
  variant: NonNullable<BadgeProps['variant']>;
  /** Resolved class string for the variant, for callers rendering their own element. */
  className: string;
}

function info(label: string, variant: NonNullable<BadgeProps['variant']>): CacheBadgeInfo {
  return { label, variant, className: badgeVariants({ variant }) };
}

/**
 * Pure mapping from entry content to a cache pill descriptor; `null` for any
 * non-cache or unrecognized content.
 */
export function cacheBadge(content: unknown): CacheBadgeInfo | null {
  if (!isCacheContent(content)) return null;
  const tierSuffix = typeof content.tier === 'string' ? ` ${content.tier.toUpperCase()}` : '';
  if (content.operation === 'set') return info(`SET${tierSuffix}`, 'muted');
  if (content.operation === 'delete') return info('DEL', 'muted');
  if (content.operation === 'clear') return info('CLEAR', 'muted');
  if (content.hit === true) {
    // A grace-period (stale) hit warns so it's distinguishable from a fresh hit.
    const stale = content.stale === true;
    return info(`${stale ? 'HIT·STALE' : 'HIT'}${tierSuffix}`, stale ? 'warn' : 'good');
  }
  if (content.hit === false) return info(`MISS${tierSuffix}`, 'warn');
  return null;
}

/** Small cache hit/miss/set status pill; renders nothing for non-cache content. */
export function CacheBadge({ content }: { content: unknown }): JSX.Element | null {
  const badge = cacheBadge(content);
  if (badge === null) return null;
  return <Badge variant={badge.variant}>{badge.label}</Badge>;
}
