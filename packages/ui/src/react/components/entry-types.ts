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
  /**
   * Optional override for the backend fetch filter. When set, the entries
   * query uses this instead of `{ type: id }` — e.g. `schedule` is recorded
   * as a tagged `job`, so it fetches `{ type: 'job', tag: 'schedule' }`.
   */
  query?: { type?: string; tag?: string };
}

export const ENTRY_TYPES: EntryTypeDef[] = [
  { id: 'request', label: 'Requests', dot: 'bg-emerald-400' },
  { id: 'query', label: 'Queries', dot: 'bg-sky-400' },
  { id: 'exception', label: 'Exceptions', dot: 'bg-red-400' },
  { id: 'job', label: 'Jobs', dot: 'bg-violet-400' },
  { id: 'mail', label: 'Mail', dot: 'bg-pink-400' },
  { id: 'cache', label: 'Cache', dot: 'bg-teal-400' },
  {
    id: 'schedule',
    label: 'Schedule',
    dot: 'bg-orange-400',
    query: { type: 'job', tag: 'schedule' },
  },
  { id: 'http_client', label: 'HTTP Client', dot: 'bg-amber-400' },
  { id: 'dump', label: 'Dumps', dot: 'bg-fuchsia-400' },
  { id: 'event', label: 'Events', dot: 'bg-indigo-400' },
  { id: 'log', label: 'Logs', dot: 'bg-zinc-400' },
  { id: 'model', label: 'Models', dot: 'bg-lime-400' },
  { id: 'redis', label: 'Redis', dot: 'bg-rose-400' },
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

/**
 * The backend fetch filter for a nav/route type id. Most types fetch
 * `{ type: id }`, but a few (e.g. `schedule`) override via `query` — scheduled
 * runs are stored as `job` entries tagged `schedule`, so the route id and the
 * backend filter diverge. Unknown ids fall back to `{ type: id }`.
 */
export function resolveEntryQuery(typeId: string): { type?: string; tag?: string } {
  return BY_ID[typeId]?.query ?? { type: typeId };
}
