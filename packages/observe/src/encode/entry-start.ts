import type { Entry } from '@dudousxd/nestjs-telescope';

/**
 * When the operation an entry describes actually BEGAN, in ms since epoch.
 *
 * Every watcher records with `RecordInput.startedAt`, so an entry's `createdAt`
 * is the start of the work it describes and `durationMs` runs forward from it.
 */
export function entryStartMs(entry: Entry): number {
  return entry.createdAt.getTime();
}
