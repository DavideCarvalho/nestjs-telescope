// packages/core/src/pulse/pulse.service.spec.ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { PulseService } from './pulse.service.js';

function entry(type: string, content: unknown, durationMs: number | null, createdAt: Date): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: type === 'exception' ? 'Error:boom' : null,
    content,
    tags: [],
    sequence: 0,
    durationMs,
    origin: 'http',
    instanceId: 'i',
    createdAt,
  };
}

describe('PulseService', () => {
  it('summarizes entries within the window from storage', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('query', { sql: 'select 1' }, 300, new Date(now - 60_000)),
      entry('request', { uri: '/a', method: 'GET' }, 50, new Date(now - 60_000)),
      entry('exception', { class: 'Error', message: 'boom' }, null, new Date(now - 60_000)),
    ]);
    const service = new PulseService(storage);

    const report = await service.getHealth(3_600_000);

    expect(report.counts).toMatchObject({ query: 1, request: 1, exception: 1 });
    expect(report.slowest[0]!.durationMs).toBe(300);
    expect(report.topExceptions[0]!.count).toBe(1);
    expect(report.scanned).toBe(3);
    expect(report.truncated).toBe(false);
  });

  it('excludes entries older than the window', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('query', { sql: 'a' }, 10, new Date(now - 30_000)),
      entry('query', { sql: 'b' }, 10, new Date(now - 600_000)),
    ]);
    const report = await new PulseService(storage).getHealth(60_000);
    expect(report.scanned).toBe(1);
  });

  it('rejects a non-positive window', async () => {
    const service = new PulseService(new InMemoryStorageProvider());
    await expect(service.getHealth(0)).rejects.toBeInstanceOf(RangeError);
    await expect(service.getHealth(-1)).rejects.toBeInstanceOf(RangeError);
  });
});
