// packages/core/src/query/n-plus-one.ts
import { type Entry, EntryType } from '../entry/entry.js';

export interface NPlusOneInsight {
  familyHash: string;
  count: number;
  sql: string;
}

/** Group query entries by familyHash; report templates run >= threshold times. */
export function detectNPlusOne(entries: Entry[], threshold: number): NPlusOneInsight[] {
  const groups = new Map<string, { count: number; sql: string }>();
  for (const entry of entries) {
    if (entry.type !== EntryType.Query || entry.familyHash === null) continue;
    const record =
      typeof entry.content === 'object' && entry.content !== null
        ? (entry.content as Record<string, unknown>)
        : null;
    const sql = record !== null && typeof record.sql === 'string' ? record.sql : '';
    const existing = groups.get(entry.familyHash);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(entry.familyHash, { count: 1, sql });
    }
  }
  const insights: NPlusOneInsight[] = [];
  for (const [familyHash, group] of groups) {
    if (group.count >= threshold) {
      insights.push({ familyHash, count: group.count, sql: group.sql });
    }
  }
  return insights;
}
