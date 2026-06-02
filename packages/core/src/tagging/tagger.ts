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

export const BUILTIN_TAGGERS: readonly Tagger[] = [statusTagger, slowTagger];

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
