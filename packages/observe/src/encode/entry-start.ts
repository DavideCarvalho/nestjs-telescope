import type { Entry } from '@dudousxd/nestjs-telescope';

/**
 * When the operation an entry describes actually BEGAN, in ms since epoch.
 *
 * No watcher in the ecosystem passes `RecordInput.startedAt`, so the Recorder
 * stamps `createdAt` at record time — and every watcher records once its work
 * has finished. `createdAt` is therefore an END timestamp, and `durationMs` is
 * what walks it back to the start.
 *
 * Observe's waterfall is built from starts: without this the request's own start
 * would be later than every span inside it, every offset would clamp to zero,
 * and the timeline would collapse into a single column.
 */
export function entryStartMs(entry: Entry): number {
  const recordedAt = entry.createdAt.getTime();
  if (!Number.isFinite(recordedAt)) return Number.NaN;
  const duration = entry.durationMs;
  if (duration === null || !Number.isFinite(duration) || duration < 0) return recordedAt;
  return recordedAt - duration;
}
