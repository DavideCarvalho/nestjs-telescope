import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { EntryQuery, Page } from '../storage/storage-provider.js';
import { summarizeStats } from './stats.js';
import { StatsService } from './stats.service.js';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const WINDOW_MS = 600_000;

let sequence = 0;
function entry(overrides: Partial<Entry> & Pick<Entry, 'type' | 'content'>): Entry {
  sequence += 1;
  return {
    id: `e-${String(sequence).padStart(6, '0')}`,
    batchId: 'b',
    familyHash: null,
    tags: [],
    sequence,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(NOW - sequence * 1000),
    ...overrides,
  };
}

/** Records every read so a test can see what the stats scan asked the store for. */
class RecordingStorage extends InMemoryStorageProvider {
  readonly reads: EntryQuery[] = [];

  override async get(query: EntryQuery): Promise<Page<Entry>> {
    this.reads.push(query);
    return super.get(query);
  }
}

function seed(): Entry[] {
  const padding = 'x'.repeat(2000);
  const entries: Entry[] = [];
  for (let index = 0; index < 60; index += 1) {
    const statusCode = [200, 201, 302, 404, 500][index % 5] ?? 200;
    entries.push(
      entry({
        type: 'request',
        content: { statusCode, uri: `/r/${index}`, padding },
        tags: [`status:${statusCode}`],
        durationMs: index,
      }),
    );
    entries.push(
      entry({
        type: 'query',
        familyHash: `fam-${index % 7}`,
        content: { sql: `select ${index % 7} from t /* ${padding} */`, bindings: [] },
        durationMs: index * 2,
      }),
    );
    entries.push(
      entry({
        type: 'exception',
        familyHash: index % 9 === 0 ? null : `Error:${index % 4}`,
        content: { class: `Error${index % 4}`, message: `boom ${index % 4}`, stack: padding },
      }),
    );
  }
  // A request recorded without its status tag (e.g. stored by another writer)
  // and one with a null status: both must still be classified from content.
  entries.push(entry({ type: 'request', content: { statusCode: 503 }, tags: [] }));
  entries.push(entry({ type: 'request', content: { statusCode: null }, tags: [] }));
  return entries;
}

describe('StatsService content reads', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    sequence = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const type of ['request', 'query', 'exception']) {
    it(`scans ${type} entries without content and still matches a full-content summary`, async () => {
      const storage = new RecordingStorage();
      const all = seed();
      await storage.store(all);
      const service = new StatsService(storage, { pageSize: 25 });

      const result = await service.getStats({ type, windowMs: WINDOW_MS });

      const ofType = all
        .filter((candidate) => candidate.type === type)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const expected = summarizeStats({
        entries: ofType,
        type,
        windowStart: new Date(NOW - WINDOW_MS),
        windowEnd: new Date(NOW),
        windowMs: WINDOW_MS,
        buckets: 60,
        slowMs: 100,
        truncated: false,
      });
      expect(result).toEqual(expected);

      const scans = storage.reads.filter((read) => read.ids === undefined);
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) expect(scan.omitContent).toBe(true);
      const hydrated = storage.reads.flatMap((read) => read.ids ?? []);
      expect(hydrated.length).toBeLessThan(ofType.length / 2);
    });
  }

  it('keeps reading cache content, whose hit/miss lives only there', async () => {
    const storage = new RecordingStorage();
    await storage.store([
      entry({ type: 'cache', content: { operation: 'get', key: 'k', hit: true } }),
      entry({ type: 'cache', content: { operation: 'get', key: 'k', hit: false } }),
    ]);
    const result = await new StatsService(storage).getStats({ type: 'cache', windowMs: WINDOW_MS });
    expect(result.cache?.hits).toBe(1);
    expect(result.cache?.misses).toBe(1);
  });
});
