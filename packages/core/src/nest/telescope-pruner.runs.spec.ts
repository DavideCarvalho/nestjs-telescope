// packages/core/src/nest/telescope-pruner.runs.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopePruner } from './telescope-pruner.service.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'id',
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(),
    ...over,
  };
}

/** Drives a single prune tick and waits for its async chain to settle. */
async function tick(intervalMs: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(intervalMs + 10);
}

describe('TelescopePruner run recording', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a scheduled cycle with real per-type deletedByType and the bulk in the total', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const intervalMs = 100;
    const storage = new InMemoryStorageProvider();
    await storage.store([
      // request 2h old → pruned in the BULK scope (global 1h cutoff); counts in
      // deletedTotal but is NOT attributed to a type key.
      entry({ id: 'req-2h', type: 'request', createdAt: new Date('2026-05-31T22:00:00Z') }),
      // exception 8d old → pruned in its OWN scope (7d override) → real per-type count.
      entry({ id: 'exc-8d', type: 'exception', createdAt: new Date('2026-05-24T00:00:00Z') }),
      // exception 2h old → within its 7d override → survives.
      entry({ id: 'exc-2h', type: 'exception', createdAt: new Date('2026-05-31T22:00:00Z') }),
    ]);
    const config = resolveConfig({
      enabled: true,
      prune: { after: '1h', intervalMs, perType: { exception: '7d' } },
    });
    const pruner = new TelescopePruner(config, storage);
    pruner.onApplicationBootstrap();
    await tick(intervalMs);
    pruner.onApplicationShutdown();

    const runs = pruner.getRuns();
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run.trigger).toBe('scheduled');
    expect(run.deletedTotal).toBe(2);
    expect(run.deletedByType).toEqual({ exception: 1 });
    expect(run.error).toBeUndefined();
    expect(typeof run.durationMs).toBe('number');
    expect(run.at).toBe('2026-06-01T00:00:00.100Z');
  });

  it('predicts nextRunAt from the last scheduled run start + interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const intervalMs = 100;
    const storage = new InMemoryStorageProvider();
    const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs } });
    const pruner = new TelescopePruner(config, storage);

    // Before the first cycle: now + interval.
    expect(pruner.getNextRunAtMs()).toBe(new Date('2026-06-01T00:00:00Z').getTime() + intervalMs);

    pruner.onApplicationBootstrap();
    await tick(intervalMs);
    pruner.onApplicationShutdown();

    // After one cycle: the scheduled run started at +100ms, so next is +200ms.
    expect(pruner.getNextRunAtMs()).toBe(
      new Date('2026-06-01T00:00:00.100Z').getTime() + intervalMs,
    );
  });

  it('records an on-demand pruneNow() as a manual run without moving the schedule', async () => {
    // Freeze the clock: before the first scheduled cycle getNextRunAtMs() is
    // `now + interval`, so without fake timers the few real ms that pruneNow()
    // takes would float the prediction and the before/after compare would flake.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const storage = new InMemoryStorageProvider();
    await storage.store([
      entry({ id: 'old', type: 'request', createdAt: new Date('2020-01-01T00:00:00Z') }),
    ]);
    const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs: 60_000 } });
    const pruner = new TelescopePruner(config, storage);

    const before = pruner.getNextRunAtMs();
    const deleted = await pruner.pruneNow();
    expect(deleted).toBe(1);

    const runs = pruner.getRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe('manual');
    expect(runs[0].deletedTotal).toBe(1);
    // A manual prune does not advance the SCHEDULED prediction window.
    expect(pruner.getNextRunAtMs()).toBe(before);
  });

  it('caps the ring at the newest 100 runs', async () => {
    const storage = new InMemoryStorageProvider();
    const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs: 60_000 } });
    const pruner = new TelescopePruner(config, storage);
    for (let i = 0; i < 105; i += 1) await pruner.pruneNow();
    expect(pruner.getRuns()).toHaveLength(100);
  });

  it('getNextRunAtMs is null when no prune window is configured', () => {
    const storage = new InMemoryStorageProvider();
    const config = resolveConfig({ enabled: true });
    const pruner = new TelescopePruner(config, storage);
    expect(pruner.getNextRunAtMs()).toBeNull();
  });
});
