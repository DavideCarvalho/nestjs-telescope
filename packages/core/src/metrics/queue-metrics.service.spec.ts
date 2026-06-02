// packages/core/src/metrics/queue-metrics.service.spec.ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
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
});
