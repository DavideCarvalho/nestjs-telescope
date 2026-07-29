/**
 * Inertia entries carry `content: { component, statusCode, isPartial,
 * versionMismatch, props: { deferred }, pageBytes, ... }`. This module derives a
 * small set of status pills from that content: a red `409` when the render was a
 * forced version-mismatch reload, a `partial` chip for partial reloads, a
 * `deferred` chip when there are deferred prop groups, and a human-readable
 * page-size chip. Mirrors the semantic-variant style of `cache-badge.tsx`.
 */
import { Badge, type BadgeProps, badgeVariants } from '../ui/index.js';

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
  /**
   * Semantic role, not a colour: which `Badge` variant renders this pill.
   * Prefer this over {@link InertiaBadgeInfo.className} in new code.
   */
  variant: NonNullable<BadgeProps['variant']>;
  /** Resolved class string for the variant, for callers rendering their own element. */
  className: string;
}

function badge(label: string, variant: NonNullable<BadgeProps['variant']>): InertiaBadgeInfo {
  return { label, variant, className: badgeVariants({ variant }) };
}

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
  if (info.versionMismatch) badges.push(badge('409', 'bad'));
  if (info.isPartial) badges.push(badge('partial', 'warn'));
  if (Object.keys(info.deferred).length > 0) badges.push(badge('deferred', 'brand'));
  badges.push(badge(humanBytes(info.pageBytes), 'muted'));
  return badges;
}

/** Inertia status pills; renders nothing for non-inertia content. */
export function InertiaBadge({ content }: { content: unknown }): JSX.Element | null {
  const badges = inertiaBadges(content);
  if (badges.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {badges.map((pill) => (
        <Badge key={pill.label} variant={pill.variant}>
          {pill.label}
        </Badge>
      ))}
    </span>
  );
}
