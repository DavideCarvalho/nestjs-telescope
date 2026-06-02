// packages/core/src/metrics/collect-window.spec.ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { collectEntriesInWindow } from './collect-window.js';

function entry(type: string, createdAt: Date): Entry {
  return {
    id: `${type}-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    createdAt,
  };
}

describe('collectEntriesInWindow', () => {
  it('paginates across pages and returns all matching entries', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store(
      Array.from({ length: 1200 }, (_, i) => entry('query', new Date(now - i * 10))),
    );
    const result = await collectEntriesInWindow(storage, { after: new Date(now - 3_600_000) });
    expect(result.entries).toHaveLength(1200);
    expect(result.scanned).toBe(1200);
    expect(result.truncated).toBe(false);
  });

  it('passes the base query through (type filter)', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('query', new Date(now - 1000)),
      entry('request', new Date(now - 1000)),
    ]);
    const result = await collectEntriesInWindow(storage, {
      type: 'query',
      after: new Date(now - 3_600_000),
    });
    expect(result.scanned).toBe(1);
    expect(result.entries[0]!.type).toBe('query');
  });

  it('caps the scan and flags truncation, keeping the newest entries', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store(
      Array.from({ length: 5 }, (_, i) => entry('query', new Date(now - i * 10))),
    );
    const result = await collectEntriesInWindow(
      storage,
      { after: new Date(now - 3_600_000) },
      { scanCap: 3 },
    );
    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(3);
    expect(result.entries).toHaveLength(3);
  });

  it('terminates when a store returns an empty page with a non-null cursor', async () => {
    const hostile: StorageProvider = {
      get: async () => ({ data: [], nextCursor: 'never-null' }),
      store: async () => {},
      update: async () => {},
      find: async () => null,
      batch: async () => [],
      tags: async () => [],
      prune: async () => 0,
      clear: async () => {},
    };
    const result = await collectEntriesInWindow(hostile, { after: new Date() });
    expect(result.scanned).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('terminates when the cursor does not advance', async () => {
    const stuck: StorageProvider = {
      get: async () => ({ data: [entry('query', new Date())], nextCursor: 'stuck' }),
      store: async () => {},
      update: async () => {},
      find: async () => null,
      batch: async () => [],
      tags: async () => [],
      prune: async () => 0,
      clear: async () => {},
    };
    const result = await collectEntriesInWindow(stuck, { after: new Date() });
    expect(result.scanned).toBe(2);
  });
});
