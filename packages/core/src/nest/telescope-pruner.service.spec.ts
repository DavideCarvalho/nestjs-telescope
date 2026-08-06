// packages/core/src/nest/telescope-pruner.service.spec.ts
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { TelescopePruner } from './telescope-pruner.service.js';

function makeRejectingStorage(): StorageProvider {
  return {
    store: () => Promise.resolve(),
    update: () => Promise.resolve(),
    find: () => Promise.resolve(null),
    get: () => Promise.resolve({ data: [], nextCursor: null }),
    batch: () => Promise.resolve([]),
    tags: () => Promise.resolve([]),
    prune: () => Promise.reject(new Error('boom')),
    clear: () => Promise.resolve(),
  };
}

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

describe('TelescopePruner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a rejecting storage.prune does not produce an unhandled rejection and does not throw', async () => {
    vi.useFakeTimers();
    const intervalMs = 100;
    const config = resolveConfig({
      enabled: true,
      prune: { after: '1h', intervalMs },
    });
    const storage = makeRejectingStorage();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const pruner = new TelescopePruner(config, storage);

    expect(() => pruner.onApplicationBootstrap()).not.toThrow();
    await tick(intervalMs);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));

    pruner.onApplicationShutdown();
    warnSpy.mockRestore();
  });

  describe('per-type retention', () => {
    it('prunes overridden type at its own cutoff while others use the global cutoff', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      const intervalMs = 100;
      const storage = new InMemoryStorageProvider();
      // Ages relative to now (2026-06-01): global after = 1h, exception after = 7d.
      await storage.store([
        // request 2h old → older than global 1h → pruned
        entry({ id: 'req-2h', type: 'request', createdAt: new Date('2026-05-31T22:00:00Z') }),
        // request 30m old → within global → survives
        entry({ id: 'req-30m', type: 'request', createdAt: new Date('2026-05-31T23:30:00Z') }),
        // exception 2h old → older than global but WITHIN its 7d override → survives
        entry({ id: 'exc-2h', type: 'exception', createdAt: new Date('2026-05-31T22:00:00Z') }),
        // exception 8d old → older than its 7d override → pruned
        entry({ id: 'exc-8d', type: 'exception', createdAt: new Date('2026-05-24T00:00:00Z') }),
      ]);
      const config = resolveConfig({
        enabled: true,
        prune: { after: '1h', intervalMs, perType: { exception: '7d' } },
      });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      const ids = (await storage.get({})).data.map((e) => e.id).sort();
      expect(ids).toEqual(['exc-2h', 'req-30m']);
    });

    it('absent perType is identical to the prior global-only behaviour', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      const intervalMs = 100;
      const storage = new InMemoryStorageProvider();
      await storage.store([
        entry({ id: 'old', type: 'exception', createdAt: new Date('2026-05-31T22:00:00Z') }),
        entry({ id: 'new', type: 'exception', createdAt: new Date('2026-05-31T23:55:00Z') }),
      ]);
      const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs } });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      expect((await storage.get({})).data.map((e) => e.id)).toEqual(['new']);
    });

    it('rejects an unparseable perType duration at config resolution', () => {
      expect(() =>
        resolveConfig({ enabled: true, prune: { after: '1h', perType: { exception: 'banana' } } }),
      ).toThrow(/Invalid duration/);
    });

    it('falls back to the global prune (warn once) when provider lacks pruneScoped', async () => {
      vi.useFakeTimers();
      const intervalMs = 100;
      const pruneSpy = vi.fn(() => Promise.resolve(0));
      // A legacy provider WITHOUT pruneScoped.
      const storage: StorageProvider = {
        store: () => Promise.resolve(),
        update: () => Promise.resolve(),
        find: () => Promise.resolve(null),
        get: () => Promise.resolve({ data: [], nextCursor: null }),
        batch: () => Promise.resolve([]),
        tags: () => Promise.resolve([]),
        prune: pruneSpy,
        clear: () => Promise.resolve(),
      };
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({
        enabled: true,
        prune: { after: '1h', intervalMs, perType: { exception: '7d' } },
      });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      // Global prune called (once per cycle, for the global scope only — NOT per type).
      expect(pruneSpy).toHaveBeenCalledTimes(2);
      // Capability warning logged exactly once despite two cycles.
      const scopedWarnings = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes('does not implement pruneScoped'),
      );
      expect(scopedWarnings).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });

  describe('archive sink', () => {
    it('hands doomed entries to the sink BEFORE deleting them', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      const intervalMs = 100;
      const storage = new InMemoryStorageProvider();
      const doomed = entry({
        id: 'exc-old',
        type: 'exception',
        createdAt: new Date('2026-05-31T22:00:00Z'),
      });
      await storage.store([
        doomed,
        entry({ id: 'req-old', type: 'request', createdAt: new Date('2026-05-31T22:00:00Z') }),
      ]);

      const seen: string[] = [];
      const sink = vi.fn(async (entries: Entry[]) => {
        // The entries must still exist in storage at sink time (not yet deleted).
        seen.push(...entries.map((e) => e.id));
        expect(await storage.find('exc-old')).not.toBeNull();
      });
      const config = resolveConfig({
        enabled: true,
        prune: { after: '1h', intervalMs },
        archive: { types: ['exception'], sink },
      });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      expect(seen).toEqual(['exc-old']);
      // After the cycle the archived type IS deleted; the non-archived request too.
      expect((await storage.get({})).data).toHaveLength(0);
    });

    it('keeps archived entries when the sink rejects, prunes others, and retries next cycle', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      const intervalMs = 100;
      const storage = new InMemoryStorageProvider();
      await storage.store([
        entry({ id: 'exc-old', type: 'exception', createdAt: new Date('2026-05-31T22:00:00Z') }),
        entry({ id: 'req-old', type: 'request', createdAt: new Date('2026-05-31T22:00:00Z') }),
      ]);

      let attempt = 0;
      const sink = vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('sink down');
      });
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({
        enabled: true,
        prune: { after: '1h', intervalMs },
        archive: { types: ['exception'], sink },
      });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();

      // Cycle 1: sink fails → exception survives, but the non-archived request is pruned.
      await tick(intervalMs);
      expect(await storage.find('exc-old')).not.toBeNull();
      expect(await storage.find('req-old')).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sink down'));

      // Cycle 2: sink succeeds → exception finally archived + deleted.
      await tick(intervalMs);
      expect(await storage.find('exc-old')).toBeNull();

      pruner.onApplicationShutdown();
      warnSpy.mockRestore();
    });

    it('caps archived batches per type per cycle and defers the remainder', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      const intervalMs = 100;
      const storage = new InMemoryStorageProvider();
      // 5 doomed exceptions; batchSize 1, cap 2 → only 2 archived this cycle, none deleted.
      const old = new Date('2026-05-31T22:00:00Z');
      await storage.store([
        entry({ id: 'e1', type: 'exception', createdAt: old }),
        entry({ id: 'e2', type: 'exception', createdAt: old }),
        entry({ id: 'e3', type: 'exception', createdAt: old }),
        entry({ id: 'e4', type: 'exception', createdAt: old }),
        entry({ id: 'e5', type: 'exception', createdAt: old }),
      ]);
      const sink = vi.fn(async () => undefined);
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({
        enabled: true,
        prune: { after: '1h', intervalMs },
        archive: { types: ['exception'], sink, batchSize: 1, maxBatchesPerCycle: 2 },
      });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      // Exactly the cap (2) batches ran; the cap-hit warning fired; nothing deleted
      // (the unarchived remainder must survive, so the delete is skipped this cycle).
      expect(sink).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('per-cycle batch cap'));
      expect((await storage.get({ type: 'exception' })).data).toHaveLength(5);
      warnSpy.mockRestore();
    });

    it('a sink failure does not affect non-archived types', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      const intervalMs = 100;
      const storage = new InMemoryStorageProvider();
      const old = new Date('2026-05-31T22:00:00Z');
      await storage.store([
        entry({ id: 'exc-old', type: 'exception', createdAt: old }),
        entry({ id: 'job-old', type: 'job', createdAt: old }),
        entry({ id: 'req-old', type: 'request', createdAt: old }),
      ]);
      const sink = vi.fn(async () => {
        throw new Error('nope');
      });
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({
        enabled: true,
        prune: { after: '1h', intervalMs },
        archive: { types: ['exception'], sink },
      });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      // exception kept (sink failed), job + request pruned normally.
      const ids = (await storage.get({})).data.map((e) => e.id).sort();
      expect(ids).toEqual(['exc-old']);
      warnSpy.mockRestore();
    });
  });
  describe('overlap guard', () => {
    /**
     * A storage whose `pruneScoped` never settles on its own: each call parks on
     * a promise the test resolves by hand, so a cycle can be held open across
     * several timer ticks.
     */
    function makeBlockingStorage(): {
      storage: StorageProvider;
      calls: () => number;
      releaseAll: () => void;
    } {
      const pending: Array<() => void> = [];
      let calls = 0;
      const storage: StorageProvider = {
        store: () => Promise.resolve(),
        update: () => Promise.resolve(),
        find: () => Promise.resolve(null),
        get: () => Promise.resolve({ data: [], nextCursor: null }),
        batch: () => Promise.resolve([]),
        tags: () => Promise.resolve([]),
        prune: () => Promise.resolve(0),
        pruneScoped: () => {
          calls += 1;
          return new Promise<number>((resolve) => {
            pending.push(() => resolve(1));
          });
        },
        clear: () => Promise.resolve(),
      };
      return {
        storage,
        calls: () => calls,
        releaseAll: () => {
          for (const resolve of pending.splice(0)) resolve();
        },
      };
    }

    it('drops scheduled ticks while a cycle is still running, and warns once', async () => {
      vi.useFakeTimers();
      const intervalMs = 100;
      const { storage, calls, releaseAll } = makeBlockingStorage();
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs } });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();

      // First tick opens a cycle that parks inside pruneScoped. Five more ticks
      // fire while it is still in flight and must ALL be dropped, so the store
      // still sees exactly the one delete from the first cycle.
      await tick(intervalMs);
      expect(calls()).toBe(1);
      for (let i = 0; i < 5; i += 1) await tick(intervalMs);
      expect(calls()).toBe(1);

      // The overlap warning is latched: one line for the whole streak, not one
      // per dropped tick.
      const overlapWarnings = warnSpy.mock.calls.filter(
        (args) =>
          typeof args[0] === 'string' && args[0].includes('still running when the next tick fired'),
      );
      expect(overlapWarnings).toHaveLength(1);

      // Nothing was recorded for the dropped ticks — one cycle ran, so once it
      // finishes there is exactly one run.
      releaseAll();
      await vi.advanceTimersByTimeAsync(0);
      expect(pruner.getRuns()).toHaveLength(1);

      pruner.onApplicationShutdown();
      warnSpy.mockRestore();
    });

    it('resumes on the next tick once the slow cycle finishes', async () => {
      vi.useFakeTimers();
      const intervalMs = 100;
      const { storage, calls, releaseAll } = makeBlockingStorage();
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs } });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();

      await tick(intervalMs);
      await tick(intervalMs);
      expect(calls()).toBe(1);

      releaseAll();
      await vi.advanceTimersByTimeAsync(0);
      await tick(intervalMs);
      expect(calls()).toBe(2);

      pruner.onApplicationShutdown();
      warnSpy.mockRestore();
    });

    it('pruneNow() joins the in-flight cycle instead of starting a second one', async () => {
      vi.useFakeTimers();
      const intervalMs = 100;
      const { storage, calls, releaseAll } = makeBlockingStorage();
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs } });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();

      await tick(intervalMs);
      expect(calls()).toBe(1);

      const manual = pruner.pruneNow();
      const alsoManual = pruner.pruneNow();
      expect(calls()).toBe(1);

      releaseAll();
      // Both manual calls resolve with the joined cycle's deleted count, and only
      // that one cycle was ever recorded.
      expect(await manual).toBe(1);
      expect(await alsoManual).toBe(1);
      expect(pruner.getRuns()).toHaveLength(1);
      expect(pruner.getRuns()[0]?.trigger).toBe('scheduled');

      pruner.onApplicationShutdown();
      warnSpy.mockRestore();
    });
  });
});
