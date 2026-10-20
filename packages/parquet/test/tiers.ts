import type { Entry, StorageProvider } from '@dudousxd/nestjs-telescope';
import type { TieredStorageProvider } from '../src/tiered-storage.js';

/**
 * `afterSeed` for the conformance suite: moves the older half of what is in the hot tier to the
 * cold tier, the way the pruner's archive-then-delete does, so every read assertion also runs
 * across the tier boundary.
 */
export async function archiveOlderHalf(provider: StorageProvider, seeded: Entry[]): Promise<void> {
  const tiered = provider as TieredStorageProvider;
  const times = seeded.map((entry) => entry.createdAt.getTime()).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  if (median === undefined) return;
  await moveToCold(tiered, new Date(median));
}

/** Archives every hot entry older than `before` to the cold tier, then deletes it from hot. */
export async function moveToCold(tiered: TieredStorageProvider, before: Date): Promise<number> {
  const doomed: Entry[] = [];
  let cursor: string | undefined;
  do {
    const page = await tiered.hot.get({ before, limit: 500, ...(cursor ? { cursor } : {}) });
    doomed.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  await tiered.cold.write(doomed);
  await tiered.hot.prune(before);
  return doomed.length;
}
