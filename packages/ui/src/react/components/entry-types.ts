/**
 * Single source of truth for the known telescope entry types: their stable
 * id (the backend `type` filter value), a human label, and a Tailwind `bg-*`
 * dot color. The dot palette mirrors the `fill-*` tokens in `stacked-bars`.
 */
export interface EntryTypeDef {
  /** Backend filter value, e.g. passed as `entries({ type })`. */
  id: string;
  /** Human-facing nav / tab label. */
  label: string;
  /** Tailwind `bg-*` class for the per-type color dot. */
  dot: string;
}

export const ENTRY_TYPES: EntryTypeDef[] = [
  { id: 'request', label: 'Requests', dot: 'bg-emerald-400' },
  { id: 'query', label: 'Queries', dot: 'bg-sky-400' },
  { id: 'exception', label: 'Exceptions', dot: 'bg-red-400' },
  { id: 'job', label: 'Jobs', dot: 'bg-violet-400' },
  { id: 'mail', label: 'Mail', dot: 'bg-pink-400' },
  { id: 'cache', label: 'Cache', dot: 'bg-teal-400' },
  { id: 'schedule', label: 'Schedule', dot: 'bg-orange-400' },
  { id: 'http_client', label: 'HTTP Client', dot: 'bg-amber-400' },
];

const FALLBACK_DOT = 'bg-zinc-500';

const BY_ID: Record<string, EntryTypeDef> = Object.fromEntries(
  ENTRY_TYPES.map((type) => [type.id, type]),
);

/** Dot color for a type id; unknown types get a neutral fallback. */
export function dotForType(typeId: string): string {
  return BY_ID[typeId]?.dot ?? FALLBACK_DOT;
}

/** Human label for a type id; unknown types echo the raw id. */
export function labelForType(typeId: string): string {
  return BY_ID[typeId]?.label ?? typeId;
}

/** True when `typeId` is a known, navigable entry type. */
export function isKnownType(typeId: string): boolean {
  return typeId in BY_ID;
}
