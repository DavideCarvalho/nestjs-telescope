// packages/core/src/tagging/tagger.ts
import { type Entry, EntryType } from '../entry/entry.js';

export type Tagger = (entry: Entry) => string[];

/** Default threshold (ms) above which an entry is tagged 'slow'. */
export const SLOW_THRESHOLD_MS = 1000;

/** Tags request entries with their HTTP status (`status:NNN`). Type-gated to
 *  request entries so a non-request content type that happens to carry a
 *  `statusCode` field is never mistaken for an HTTP response. */
export const statusTagger: Tagger = (entry) => {
  if (entry.type !== EntryType.Request) return [];
  const status = (entry.content as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? [`status:${status}`] : [];
};

export const slowTagger: Tagger = (entry) =>
  entry.durationMs !== null && entry.durationMs >= SLOW_THRESHOLD_MS ? ['slow'] : [];

/** True for a non-null object value, narrowing to a string-keyed record so its
 *  properties can be read without `as`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A usable identity token (`string`/`number`) coerced to its string form, or
 *  null. Empty strings and non-finite numbers are treated as "no identity". */
function identityToken(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  return null;
}

/** Tags request entries with the authenticated user's identity (`user:<id>`).
 *  Reads `content.user`, preferring `id`, then `_id`, then `email` — so Passport
 *  (`id`), Mongo (`_id`), and email-keyed identities all pivot. Type-gated to
 *  request entries and built from cheap property reads only (hot path); any
 *  non-object content or missing user yields no tag and never throws. */
export const userTagger: Tagger = (entry) => {
  if (entry.type !== EntryType.Request) return [];
  if (!isRecord(entry.content)) return [];
  const user = entry.content.user;
  if (!isRecord(user)) return [];
  const id = identityToken(user.id) ?? identityToken(user._id) ?? identityToken(user.email);
  return id === null ? [] : [`user:${id}`];
};

export const BUILTIN_TAGGERS: readonly Tagger[] = [statusTagger, slowTagger, userTagger];

/** Returns the entry's existing tags plus all tagger outputs, de-duplicated, order-preserving. */
export function runTaggers(entry: Entry, taggers: Tagger[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (tag: string): void => {
    if (!seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  };
  for (const tag of entry.tags) add(tag);
  for (const tagger of taggers) {
    for (const tag of tagger(entry)) add(tag);
  }
  return result;
}
