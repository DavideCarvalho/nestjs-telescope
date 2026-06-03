// packages/core/src/metrics/queue-metrics.service.spec.ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { QueueMetricsService } from './queue-metrics.service.js';

function jobEntry(queue: string, status: 'completed' | 'failed', createdAt: Date): Entry {
  return {
    id: `${queue}-${Math.random()}`,
    batchId: 'b',
    type: 'job',
    familyHash: `${queue}:x`,
    content: { queue, status, waitMs: 5 },
    tags: [],
    sequence: 0,
    durationMs: 100,
    origin: 'queue',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt,
  };
}

describe('QueueMetricsService', () => {
  it('aggregates job entries within the window from storage', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      jobEntry('mail', 'completed', new Date(now - 60_000)),
      jobEntry('mail', 'failed', new Date(now - 120_000)),
      jobEntry('reports', 'completed', new Date(now - 30_000)),
    ]);
    const service = new QueueMetricsService(storage);

    const report = await service.getQueueMetrics(3_600_000); // 1h

    expect(report.queues.map((q) => q.queue)).toEqual(['mail', 'reports']);
    expect(report.queues.find((q) => q.queue === 'mail')!.total).toBe(2);
    expect(report.scanned).toBe(3);
    expect(report.truncated).toBe(false);
  });

  it('excludes entries older than the window', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      jobEntry('mail', 'completed', new Date(now - 30_000)),
      jobEntry('mail', 'completed', new Date(now - 600_000)),
    ]);
    const service = new QueueMetricsService(storage);

    const report = await service.getQueueMetrics(60_000); // 1m
    expect(report.scanned).toBe(1);
    expect(report.queues[0]!.total).toBe(1);
  });

  it('paginates across multiple storage pages', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    const entries = Array.from({ length: 1200 }, (_, i) =>
      jobEntry('mail', 'completed', new Date(now - i * 10)),
    );
    await storage.store(entries);
    const service = new QueueMetricsService(storage);

    const report = await service.getQueueMetrics(3_600_000);
    expect(report.scanned).toBe(1200); // more than one 500-entry page
    expect(report.queues[0]!.total).toBe(1200);
  });

  it('caps the scan and flags truncation, keeping the newest entries', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      jobEntry('mail', 'completed', new Date(now - 10)),
      jobEntry('mail', 'completed', new Date(now - 20)),
      jobEntry('mail', 'completed', new Date(now - 30)),
      jobEntry('mail', 'completed', new Date(now - 40)),
      jobEntry('mail', 'completed', new Date(now - 50)),
    ]);
    const service = new QueueMetricsService(storage, { scanCap: 3 });

    const report = await service.getQueueMetrics(3_600_000);
    expect(report.truncated).toBe(true);
    expect(report.scanned).toBe(3);
    expect(report.queues[0]!.total).toBe(3); // only the newest 3 aggregated
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
    const service = new QueueMetricsService(hostile);

    const report = await service.getQueueMetrics(60_000);
    expect(report.scanned).toBe(0);
    expect(report.truncated).toBe(false);
  });

  it('terminates when the cursor does not advance', async () => {
    const stuck: StorageProvider = {
      get: async () => ({ data: [jobEntry('mail', 'completed', new Date())], nextCursor: 'stuck' }),
      store: async () => {},
      update: async () => {},
      find: async () => null,
      batch: async () => [],
      tags: async () => [],
      prune: async () => 0,
      clear: async () => {},
    };
    const service = new QueueMetricsService(stuck);

    const report = await service.getQueueMetrics(60_000);
    // page 1: cursor undefined -> push 1, nextCursor 'stuck' advances; page 2:
    // nextCursor 'stuck' === cursor 'stuck' -> break. Two reads, then stop.
    expect(report.scanned).toBe(2);
  });

  it('rejects a non-positive window', async () => {
    const service = new QueueMetricsService(new InMemoryStorageProvider());
    await expect(service.getQueueMetrics(0)).rejects.toBeInstanceOf(RangeError);
    await expect(service.getQueueMetrics(-5)).rejects.toBeInstanceOf(RangeError);
  });
});
