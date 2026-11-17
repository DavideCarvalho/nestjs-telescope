// packages/core/src/pulse/pulse-from-store.ts
//
// Pulse's first pass answered by the store: a handful of GROUP BYs (counts, slowest, per-family
// stats, per-batch query families, per-user load) instead of paging every entry of the window
// into Node. Produces the same `PulseAggregates` the scan does, ranked by the same functions, so
// the hydration pass and the output are shared.
import { EntryType } from '../entry/entry.js';
import type {
  AggregateWindow,
  EntryAggregateResult,
  EntryAggregation,
  StorageProvider,
} from '../storage/storage-provider.js';
import {
  type NPlusOneAccumulator,
  type PulseAggregates,
  type PulseOptions,
  type SlowRouteHotspot,
  rankExceptionFamilies,
  rankJobHotspots,
  rankNPlusOne,
  rankRouteHotspots,
  rankSlowest,
  rankUserLoad,
  userFromTags,
} from './pulse-summary.js';

type Aggregator = Required<Pick<StorageProvider, 'aggregate'>>;

/** Runs one aggregation and checks the store answered the kind asked. */
async function run<K extends EntryAggregation['kind']>(
  storage: Aggregator,
  request: EntryAggregation & { kind: K },
): Promise<Extract<EntryAggregateResult, { kind: K }>['rows']> {
  const result = await storage.aggregate(request);
  if (result.kind !== request.kind) {
    throw new Error(`aggregate(${request.kind}) answered ${result.kind}`);
  }
  // The kind was checked above; TypeScript cannot narrow a union by a generic key.
  return result.rows as never;
}

const USER_TAG_PREFIX = 'user:';
const QUANTILES = [0.99, 0.5];

/**
 * The pulse aggregates of the window after `windowStart`, from the store's {@link
 * StorageProvider.aggregate}. `scanned` is how many entries the window holds (nothing is
 * truncated).
 */
export async function aggregatePulseInStore(
  storage: Aggregator & Pick<StorageProvider, 'get'>,
  windowStart: Date,
  windowEnd: Date,
  options: PulseOptions,
): Promise<{ aggregates: PulseAggregates; scanned: number }> {
  const window: AggregateWindow = { after: windowStart };
  const [counted, slowestRows, families, batchFamilies, tagSets] = await Promise.all([
    run(storage, { kind: 'count', window }),
    run(storage, { kind: 'slowest', window, limit: options.topN }),
    run(storage, {
      kind: 'families',
      window: {
        ...window,
        types: [EntryType.Request, EntryType.HttpClient, EntryType.Job, EntryType.Exception],
      },
      quantiles: QUANTILES,
    }),
    run(storage, {
      kind: 'batchFamilies',
      window: { ...window, type: EntryType.Query },
      minCount: options.nPlusOneThreshold,
    }),
    run(storage, {
      kind: 'tagSets',
      window: { ...window, type: EntryType.Request },
      tagPrefix: USER_TAG_PREFIX,
    }),
  ]);

  const counts: Record<string, number> = {};
  let scanned = 0;
  for (const row of counted) {
    counts[row.type] = (counts[row.type] ?? 0) + row.count;
    scanned += row.count;
  }

  const slowest = rankSlowest(slowestRows, options);

  const hotspotsOf = (type: string): SlowRouteHotspot[] =>
    families
      .filter((row) => row.type === type && row.durationCount > 0)
      .map((row) => ({
        route: row.familyHash,
        count: row.durationCount,
        p99: row.quantiles[0] ?? 0,
        p50: row.quantiles[1] ?? 0,
      }));
  const slowRoutes = rankRouteHotspots(hotspotsOf(EntryType.Request), options);
  const slowOutgoing = rankRouteHotspots(hotspotsOf(EntryType.HttpClient), options);
  const slowJobs = rankJobHotspots(hotspotsOf(EntryType.Job), options);

  // Exceptions: ranked by count; the newest of each reported family is its representative.
  const exceptionFamilies = rankExceptionFamilies(
    families
      .filter((row) => row.type === EntryType.Exception)
      .map((row) => ({ familyHash: row.familyHash, count: row.count })),
    options,
  );
  const newestOf = async (type: string, familyHash: string) =>
    (await storage.get({ type, familyHash, after: windowStart, limit: 1, omitContent: true }))
      .data[0];
  const exceptions = (
    await Promise.all(
      exceptionFamilies.map(async (family) => {
        const newest = await newestOf(EntryType.Exception, family.familyHash);
        if (newest === undefined) return null;
        return {
          familyHash: family.familyHash,
          count: family.count,
          representativeId: newest.id,
          lastSeen: newest.createdAt,
        };
      }),
    )
  ).filter((group) => group !== null);

  // N+1: each (batch, family) group past the threshold is one tripped request.
  const hotspots = new Map<string, NPlusOneAccumulator>();
  for (const row of batchFamilies) {
    const existing = hotspots.get(row.familyHash);
    if (existing) {
      existing.requests += 1;
      existing.total += row.count;
      existing.totalDurationMs += row.durationSum;
      if (
        row.count > existing.perRequest ||
        (row.count === existing.perRequest && row.batchId < existing.sampleBatchId)
      ) {
        existing.perRequest = row.count;
        existing.sampleBatchId = row.batchId;
      }
    } else {
      hotspots.set(row.familyHash, {
        familyHash: row.familyHash,
        perRequest: row.count,
        requests: 1,
        total: row.count,
        totalDurationMs: row.durationSum,
        sampleBatchId: row.batchId,
        representativeId: '',
      });
    }
  }
  const nPlusOne = rankNPlusOne([...hotspots.values()], options);
  await Promise.all(
    nPlusOne.map(async (hotspot) => {
      hotspot.representativeId = (await newestOf(EntryType.Query, hotspot.familyHash))?.id ?? '';
    }),
  );

  const userLoad = new Map<string, { count: number; totalDurationMs: number }>();
  for (const row of tagSets) {
    const user = userFromTags(row.tags);
    if (user === null) continue;
    const existing = userLoad.get(user);
    if (existing) {
      existing.count += row.count;
      existing.totalDurationMs += row.durationSum;
    } else {
      userLoad.set(user, { count: row.count, totalDurationMs: row.durationSum });
    }
  }
  const loadByUser = rankUserLoad(userLoad, options);

  return {
    scanned,
    aggregates: {
      windowStart,
      windowEnd,
      options,
      counts,
      slowest,
      exceptions,
      nPlusOne,
      slowRoutes,
      slowOutgoing,
      slowJobs,
      loadByUser,
      hydrationIds: {
        slowest: slowest.map((candidate) => candidate.id),
        exceptions: exceptions.map((group) => group.representativeId),
        nPlusOne: nPlusOne.map((hotspot) => hotspot.representativeId),
      },
    },
  };
}
