// packages/core/src/tagging/tagger.ts
import type { Entry } from '../entry/entry.js';

export type Tagger = (entry: Entry) => string[];

/** Default threshold (ms) above which an entry is tagged 'slow'. */
export const SLOW_THRESHOLD_MS = 1000;

export const statusTagger: Tagger = (entry) => {
  const status = (entry.content as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? [`status:${status}`] : [];
};

export const slowTagger: Tagger = (entry) =>
  entry.durationMs !== null && entry.durationMs >= SLOW_THRESHOLD_MS ? ['slow'] : [];

export const BUILTIN_TAGGERS: Tagger[] = [statusTagger, slowTagger];

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
