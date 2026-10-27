import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from './in-memory-storage-provider.js';

function entry(index: number, createdAtMs: number): Entry {
  return {
    id: `id-${String(index).padStart(6, '0')}`,
    batchId: 'b',
    type: index % 2 === 0 ? 'request' : 'query',
    familyHash: null,
    content: {},
    tags: [],
    sequence: index,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(createdAtMs),
  };
}

/** The store's own predicate check, counted to see how many entries a page examines. */
function countExamined(provider: InMemoryStorageProvider) {
  return vi.spyOn(provider as unknown as { matches: () => boolean }, 'matches');
}

describe('InMemoryStorageProvider paging', () => {
  it('examines about one page of entries per page, not the whole store', async () => {
    const provider = new InMemoryStorageProvider();
    const entries = Array.from({ length: 20_000 }, (_, index) => entry(index, 1_000 + index));
    await provider.store(entries);
    const examined = countExamined(provider);

    const first = await provider.get({ limit: 50 });
    expect(first.data.map((e) => e.id)).toEqual(
      entries
        .slice(-50)
        .reverse()
        .map((e) => e.id),
    );
    const second = await provider.get({ limit: 50, cursor: first.nextCursor ?? '' });
    expect(second.data[0]?.id).toBe(entries[entries.length - 51]?.id);
    expect(examined.mock.calls.length).toBeLessThanOrEqual(2 * 51);
  });

  it('pages out-of-order inserts, ties and bounds exactly like a full sort', async () => {
    const provider = new InMemoryStorageProvider();
    const shuffled: Entry[] = [];
    for (let index = 0; index < 300; index += 1) {
      // Many entries share a millisecond and arrive out of order.
      shuffled.push(entry(index, 10_000 + ((index * 37) % 50)));
    }
    for (let index = 0; index < shuffled.length; index += 7) {
      await provider.store(shuffled.slice(index, index + 7));
    }
    const expected = [...shuffled]
      .filter((e) => e.type === 'query' && e.createdAt.getTime() > 10_005)
      .filter((e) => e.createdAt.getTime() < 10_045)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await provider.get({
        type: 'query',
        after: new Date(10_005),
        before: new Date(10_045),
        limit: 13,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      seen.push(...page.data.map((e) => e.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(expected.map((e) => e.id));
  });

  it('keeps paging in order after prune with keepLast and an update that moves an entry', async () => {
    const provider = new InMemoryStorageProvider();
    await provider.store(Array.from({ length: 20 }, (_, index) => entry(index, 1_000 + index)));
    await provider.prune(new Date(1_010), 3);
    await provider.update('id-000015', { createdAt: new Date(500) });
    const ids = (await provider.get({ limit: 100 })).data.map((e) => e.id);
    expect(ids).toEqual([
      'id-000019',
      'id-000018',
      'id-000017',
      'id-000016',
      'id-000014',
      'id-000013',
      'id-000012',
      'id-000011',
      'id-000010',
      'id-000009',
      'id-000008',
      'id-000007',
      'id-000015',
    ]);
  });
});
