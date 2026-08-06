// packages/core/src/nest/telescope-pruner.service.spec.ts
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import type { Entry } from '../entry/entry.js';
import type {
  TelescopePruneLock,
  TelescopePruneLockRequest,
  TelescopePruneLockResult,
} from '../prune/prune-lock.js';
import { pruneLockAcquired, pruneLockHeld, pruneLockUnavailable } from '../prune/prune-lock.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type {
  BoundedPruneResult,
  BoundedPruneScope,
  StorageProvider,
} from '../storage/storage-provider.js';
import { TelescopePruner } from './telescope-pruner.service.js';

/** The StorageProvider methods the pruner never touches, so fakes stay short. */
function inertStorage(): StorageProvider {
  return {
    store: () => Promise.resolve(),
    update: () => Promise.resolve(),
    find: () => Promise.resolve(null),
    get: () => Promise.resolve({ data: [], nextCursor: null }),
    batch: () => Promise.resolve([]),
    tags: () => Promise.resolve([]),
    prune: () => Promise.resolve(0),
    clear: () => Promise.resolve(),
  };
}

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

  describe('bounded batched deletes', () => {
    /**
     * A store holding `total` doomed rows that honours `limit` exactly. Records
     * every bounded call, and separately counts any UNBOUNDED `pruneScoped` so a
     * test can assert the pruner never fell back to the long-lock path.
     */
    function makeBatchedStorage(total: number): {
      storage: StorageProvider;
      batchCalls: BoundedPruneScope[];
      unboundedCalls: () => number;
      remaining: () => number;
    } {
      let remaining = total;
      let unbounded = 0;
      const batchCalls: BoundedPruneScope[] = [];
      const storage: StorageProvider = {
        ...inertStorage(),
        pruneScoped: () => {
          unbounded += 1;
          const deleted = remaining;
          remaining = 0;
          return Promise.resolve(deleted);
        },
        pruneScopedBatch: (input: BoundedPruneScope): Promise<BoundedPruneResult> => {
          batchCalls.push(input);
          const deleted = Math.min(input.limit, remaining);
          remaining -= deleted;
          return Promise.resolve({ deleted, hasMore: remaining > 0 });
        },
      };
      return {
        storage,
        batchCalls,
        unboundedCalls: () => unbounded,
        remaining: () => remaining,
      };
    }

    it('drains a scope in bounded batches instead of one unbounded DELETE', async () => {
      vi.useFakeTimers();
      const intervalMs = 1_000;
      const { storage, batchCalls, unboundedCalls, remaining } = makeBatchedStorage(2_500);
      const config = resolveConfig({
        enabled: true,
        prune: { after: '1h', intervalMs, batchSize: 1_000, batchPauseMs: 0 },
      });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      // 1000 + 1000 + 500: the loop stops on the first short batch.
      expect(batchCalls.map((call) => call.limit)).toEqual([1_000, 1_000, 1_000]);
      expect(remaining()).toBe(0);
      // The unbounded path — one statement holding row locks for the whole scan —
      // must never be taken when the provider can do bounded deletes.
      expect(unboundedCalls()).toBe(0);
      expect(pruner.getRuns()[0]?.deletedTotal).toBe(2_500);
    });

    it('never sends keepLast to a bounded batch, using the unbounded path instead', async () => {
      vi.useFakeTimers();
      const intervalMs = 1_000;
      const { storage, batchCalls, unboundedCalls } = makeBatchedStorage(2_500);
      const config = resolveConfig({
        enabled: true,
        // keepLast is a whole-set property that a per-batch bound cannot express.
        prune: { after: '1h', intervalMs, keepLast: 10, batchSize: 1_000, batchPauseMs: 0 },
      });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      expect(batchCalls).toHaveLength(0);
      expect(unboundedCalls()).toBe(1);
    });

    it('stops at the per-cycle ceiling and warns once per streak', async () => {
      vi.useFakeTimers();
      const intervalMs = 1_000;
      // Far more rows than the cycle budget: 3 batches × 10 rows against 1000.
      const { storage, batchCalls } = makeBatchedStorage(1_000);
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({
        enabled: true,
        prune: {
          after: '1h',
          intervalMs,
          batchSize: 10,
          maxBatchesPerCycle: 3,
          batchPauseMs: 0,
        },
      });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();

      await tick(intervalMs);
      // The ceiling holds: one cycle does 3 batches and stops, it does not loop
      // until the table is drained.
      expect(batchCalls).toHaveLength(3);
      expect(pruner.getRuns()[0]?.deletedTotal).toBe(30);

      // The next cycle picks the backlog up where this one left off.
      await tick(intervalMs);
      expect(batchCalls).toHaveLength(6);

      const ceilingWarnings = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes('per-cycle batch ceiling'),
      );
      expect(ceilingWarnings).toHaveLength(1);

      pruner.onApplicationShutdown();
      warnSpy.mockRestore();
    });

    it('pauses between batches but never before the first one', async () => {
      vi.useFakeTimers();
      const intervalMs = 1_000;
      const batchPauseMs = 250;
      const { storage, batchCalls } = makeBatchedStorage(30);
      const config = resolveConfig({
        enabled: true,
        prune: { after: '1h', intervalMs, batchSize: 10, batchPauseMs },
      });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();

      // The tick itself runs exactly ONE batch: no pause is paid up front, so a
      // healthy store that drains in one batch never waits.
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(batchCalls).toHaveLength(1);

      // The second batch only lands after the pause has elapsed — that gap is
      // what keeps a tight delete loop from monopolising the database.
      await vi.advanceTimersByTimeAsync(batchPauseMs);
      expect(batchCalls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(batchPauseMs);
      expect(batchCalls).toHaveLength(3);

      pruner.onApplicationShutdown();
    });

    it('warns once when the provider cannot bound its deletes', async () => {
      vi.useFakeTimers();
      const intervalMs = 100;
      const storage: StorageProvider = {
        ...inertStorage(),
        pruneScoped: () => Promise.resolve(0),
      };
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs } });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      const warnings = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes('does not implement pruneScopedBatch'),
      );
      expect(warnings).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });

  describe('cross-process prune lock', () => {
    /** A lock whose every acquire returns a scripted result, recording requests. */
    function scriptedLock(result: () => TelescopePruneLockResult): {
      lock: TelescopePruneLock;
      requests: TelescopePruneLockRequest[];
    } {
      const requests: TelescopePruneLockRequest[] = [];
      return {
        lock: {
          acquire: (request) => {
            requests.push(request);
            return Promise.resolve(result());
          },
        },
        requests,
      };
    }

    it('skips the whole cycle — no deletes, no recorded run — when another instance holds it', async () => {
      vi.useFakeTimers();
      const intervalMs = 100;
      const pruneScoped = vi.fn(() => Promise.resolve(0));
      const storage: StorageProvider = { ...inertStorage(), pruneScoped };
      const { lock, requests } = scriptedLock(() => pruneLockHeld('pod-2 has it'));
      const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs, lock } });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      expect(requests).toHaveLength(2);
      // Not one delete was issued, and no run was recorded: this pod did not
      // prune, which is a different statement from "pruned and found nothing".
      expect(pruneScoped).not.toHaveBeenCalled();
      expect(pruner.getRuns()).toHaveLength(0);
    });

    it('prunes and then releases the lease, even when the cycle throws', async () => {
      vi.useFakeTimers();
      const intervalMs = 100;
      const released: string[] = [];
      const storage: StorageProvider = {
        ...inertStorage(),
        pruneScoped: () => Promise.reject(new Error('delete blew up')),
      };
      const { lock } = scriptedLock(() =>
        pruneLockAcquired({
          key: 'telescope:prune',
          owner: 'me',
          expiresAtMs: Date.now() + 1_000,
          release: async () => {
            released.push('telescope:prune');
          },
        }),
      );
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs, lock } });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      // A failed delete must not leak the lease: without the release the whole
      // fleet would stop pruning until the TTL expired.
      expect(released).toEqual(['telescope:prune']);
      warnSpy.mockRestore();
    });

    it('fails OPEN: a broken lock warns once and prunes anyway', async () => {
      vi.useFakeTimers();
      const intervalMs = 100;
      const pruneScoped = vi.fn(() => Promise.resolve(3));
      const storage: StorageProvider = { ...inertStorage(), pruneScoped };
      const { lock } = scriptedLock(() => pruneLockUnavailable('lease table missing'));
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs, lock } });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      // Retention must not stop because the LOCK broke — that would let the
      // table grow without bound over a problem the lock only exists to optimise.
      expect(pruneScoped).toHaveBeenCalledTimes(2);
      const warnings = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes('prune lock is unavailable'),
      );
      expect(warnings).toHaveLength(1);
      warnSpy.mockRestore();
    });

    it('treats a throwing acquire as unavailable rather than crashing the cycle', async () => {
      vi.useFakeTimers();
      const intervalMs = 100;
      const pruneScoped = vi.fn(() => Promise.resolve(0));
      const storage: StorageProvider = { ...inertStorage(), pruneScoped };
      const lock: TelescopePruneLock = {
        acquire: () => Promise.reject(new Error('lock backend exploded')),
      };
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const config = resolveConfig({ enabled: true, prune: { after: '1h', intervalMs, lock } });
      const pruner = new TelescopePruner(config, storage);
      pruner.onApplicationBootstrap();
      await tick(intervalMs);
      pruner.onApplicationShutdown();

      expect(pruneScoped).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lock backend exploded'));
      warnSpy.mockRestore();
    });

    /**
     * Two pruners over ONE store — the shape of a two-pod deployment. Driven
     * through `pruneNow()` rather than the interval timer on purpose: a fake
     * timer flushes each callback's whole microtask chain before firing the next,
     * so a timer-driven version would let the first pruner finish AND release
     * before the second one ever asked, and would prove nothing.
     */
    function twoPruners(
      storage: InMemoryStorageProvider,
      lock: boolean,
    ): [TelescopePruner, TelescopePruner] {
      const build = (instanceId: string): TelescopePruner =>
        new TelescopePruner(
          resolveConfig({
            enabled: true,
            instanceId,
            prune: { after: '1h', intervalMs: 100, lock },
          }),
          storage,
        );
      return [build('pod-a'), build('pod-b')];
    }

    async function seedOneDoomedEntry(storage: InMemoryStorageProvider): Promise<void> {
      await storage.store([
        entry({ id: 'old', type: 'request', createdAt: new Date('2026-05-31T22:00:00Z') }),
      ]);
    }

    it('lock: false keeps every replica pruning independently', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      const storage = new InMemoryStorageProvider();
      await seedOneDoomedEntry(storage);
      const [first, second] = twoPruners(storage, false);

      await Promise.all([first.pruneNow(), second.pruneNow()]);

      // BOTH pruned: opting out really does restore the every-pod-for-itself
      // behaviour, which is also what proves the test below measures the lock.
      expect(first.getRuns()).toHaveLength(1);
      expect(second.getRuns()).toHaveLength(1);
    });

    it('two pruners on one lease-capable store: only one prunes', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      const storage = new InMemoryStorageProvider();
      await seedOneDoomedEntry(storage);
      // No host wiring: the default lock is the store's own lease.
      const [first, second] = twoPruners(storage, true);

      await Promise.all([first.pruneNow(), second.pruneNow()]);

      // One ran the cycle; the other stood down on the lease it could not take.
      expect(first.getRuns()).toHaveLength(1);
      expect(second.getRuns()).toHaveLength(0);
      expect((await storage.get({})).data).toHaveLength(0);
    });
  });
});
