/**
 * Inertia entries carry `content: { component, statusCode, isPartial,
 * versionMismatch, props: { deferred }, pageBytes, ... }`. This module derives a
 * small set of status pills from that content: a red `409` when the render was a
 * forced version-mismatch reload, a `partial` chip for partial reloads, a
 * `deferred` chip when there are deferred prop groups, and a human-readable
 * page-size chip. Mirrors the bordered-pill token style of `cache-badge.tsx`.
 */

interface InertiaBadgeContent {
  isPartial: boolean;
  versionMismatch: boolean;
  pageBytes: number;
  deferred: Record<string, string[]>;
}

/** Narrow unknown entry content to the (defensive) inertia badge shape. */
function readBadgeContent(content: unknown): InertiaBadgeContent | null {
  if (typeof content !== 'object' || content === null) return null;
  const record = content as Record<string, unknown>;
  if (typeof record.component !== 'string') return null;
  const props =
    typeof record.props === 'object' && record.props !== null
      ? (record.props as Record<string, unknown>)
      : {};
  const deferred =
    typeof props.deferred === 'object' && props.deferred !== null
      ? (props.deferred as Record<string, string[]>)
      : {};
  return {
    isPartial: record.isPartial === true,
    versionMismatch: record.versionMismatch === true,
    pageBytes: typeof record.pageBytes === 'number' ? record.pageBytes : 0,
    deferred,
  };
}

export interface InertiaBadgeInfo {
  label: string;
  className: string;
}

const PILL_BASE = 'rounded border px-1.5 py-0.5 text-[10px] font-medium';

/** Format a byte count as a short human-readable string (e.g. `1.2 KB`). */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Pure mapping from entry content to the list of inertia pill descriptors;
 * empty array for non-inertia / unrecognized content. The 409 version-mismatch
 * chip comes first (it's the most diagnostic), then partial, then deferred, then
 * the page-size chip.
 */
export function inertiaBadges(content: unknown): InertiaBadgeInfo[] {
  const info = readBadgeContent(content);
  if (info === null) return [];
  const badges: InertiaBadgeInfo[] = [];
  if (info.versionMismatch) {
    badges.push({ label: '409', className: `${PILL_BASE} border-red-500/40 text-red-300` });
  }
  if (info.isPartial) {
    badges.push({ label: 'partial', className: `${PILL_BASE} border-amber-500/40 text-amber-300` });
  }
  if (Object.keys(info.deferred).length > 0) {
    badges.push({
      label: 'deferred',
      className: `${PILL_BASE} border-violet-500/40 text-violet-300`,
    });
  }
  badges.push({
    label: humanBytes(info.pageBytes),
    className: `${PILL_BASE} border-zinc-700 text-zinc-300`,
  });
  return badges;
}

/** Inertia status pills; renders nothing for non-inertia content. */
export function InertiaBadge({ content }: { content: unknown }): JSX.Element | null {
  const badges = inertiaBadges(content);
  if (badges.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {badges.map((badge) => (
        <span key={badge.label} className={badge.className}>
          {badge.label}
        </span>
      ))}
    </span>
  );
}
