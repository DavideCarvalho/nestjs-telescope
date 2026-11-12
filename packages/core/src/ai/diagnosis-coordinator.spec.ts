// packages/core/src/ai/diagnosis-coordinator.spec.ts
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { tenantViewOf, withTenantView } from '../storage/tenant-scoped-storage.js';
import type { DiagnoseContext, ExceptionDiagnoser } from './diagnoser.js';
import { DiagnosisCache } from './diagnosis-cache.js';
import { DiagnosisCoordinator } from './diagnosis-coordinator.js';

function exceptionEntry(familyHash: string | null, batchId = 'b1'): Entry {
  return {
    id: `ex-${batchId}`,
    batchId,
    type: 'exception',
    familyHash,
    content: { class: 'TypeError', message: 'boom', stack: 'TypeError: boom\n  at a' },
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(0),
  };
}

/** A diagnoser that resolves with a fixed string and counts its calls. */
function countingDiagnoser(
  result = 'diagnosis',
): ExceptionDiagnoser & { calls: DiagnoseContext[] } {
  const calls: DiagnoseContext[] = [];
  return {
    calls,
    async diagnose(context: DiagnoseContext): Promise<string> {
      calls.push(context);
      return result;
    },
  };
}

async function makeStorageWithException(
  familyHash: string | null,
): Promise<InMemoryStorageProvider> {
  const storage = new InMemoryStorageProvider();
  await storage.store([exceptionEntry(familyHash)]);
  return storage;
}

describe('DiagnosisCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('on-demand diagnose', () => {
    it('runs the diagnoser, returns markdown, and caches by family', async () => {
      const storage = await makeStorageWithException('fam-A');
      const diagnoser = countingDiagnoser('## root cause');
      const coordinator = new DiagnosisCoordinator({ diagnoser }, storage);
      const entry = exceptionEntry('fam-A');

      const first = await coordinator.diagnose(entry, 3);
      expect(first).toEqual({ markdown: '## root cause', cached: false });

      // Second call for the same family is served from cache (no re-run).
      const second = await coordinator.diagnose(entry, 3);
      expect(second).toEqual({ markdown: '## root cause', cached: true });
      expect(diagnoser.calls).toHaveLength(1);
    });

    it('force=true bypasses the cache and re-runs', async () => {
      const storage = await makeStorageWithException('fam-A');
      const diagnoser = countingDiagnoser();
      const coordinator = new DiagnosisCoordinator({ diagnoser }, storage);
      const entry = exceptionEntry('fam-A');
      await coordinator.diagnose(entry, 1);
      const forced = await coordinator.diagnose(entry, 1, true);
      expect(forced.cached).toBe(false);
      expect(diagnoser.calls).toHaveLength(2);
    });

    it('propagates a diagnoser rejection (so the endpoint can map it to 502)', async () => {
      const storage = await makeStorageWithException('fam-A');
      const diagnoser: ExceptionDiagnoser = {
        diagnose: () => Promise.reject(new Error('model down')),
      };
      const coordinator = new DiagnosisCoordinator({ diagnoser }, storage);
      await expect(coordinator.diagnose(exceptionEntry('fam-A'), 1)).rejects.toThrow('model down');
    });
  });

  describe('auto mode', () => {
    it('observeFlush triggers a diagnosis ONCE per new family', async () => {
      const storage = await makeStorageWithException('fam-A');
      const diagnoser = countingDiagnoser();
      const coordinator = new DiagnosisCoordinator({ diagnoser, mode: 'auto' }, storage);

      coordinator.observeFlush([exceptionEntry('fam-A')]);
      // Same family again in a later flush — must NOT re-diagnose.
      coordinator.observeFlush([exceptionEntry('fam-A')]);
      await vi.waitFor(() => expect(diagnoser.calls.length).toBeGreaterThan(0));
      // Let any stray microtasks settle, then assert exactly one run.
      await Promise.resolve();
      expect(diagnoser.calls).toHaveLength(1);
    });

    it('does nothing on the flush path in on-demand mode', async () => {
      const storage = await makeStorageWithException('fam-A');
      const diagnoser = countingDiagnoser();
      const coordinator = new DiagnosisCoordinator({ diagnoser, mode: 'on-demand' }, storage);
      coordinator.observeFlush([exceptionEntry('fam-A')]);
      await Promise.resolve();
      expect(diagnoser.calls).toHaveLength(0);
    });

    it('observeFlush never throws even if the diagnoser rejects (flush is safe)', async () => {
      const storage = await makeStorageWithException('fam-A');
      const diagnoser: ExceptionDiagnoser = {
        diagnose: () => Promise.reject(new Error('boom')),
      };
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const coordinator = new DiagnosisCoordinator({ diagnoser, mode: 'auto' }, storage);
      expect(() => coordinator.observeFlush([exceptionEntry('fam-A')])).not.toThrow();
      // The rejection is swallowed; no unhandled rejection surfaces.
      await vi.waitFor(() => expect(Logger.prototype.warn).toHaveBeenCalled());
    });

    it('awaitForAlert returns the diagnosis once the in-flight run resolves', async () => {
      const storage = await makeStorageWithException('fam-A');
      const diagnoser = countingDiagnoser('## cause');
      const coordinator = new DiagnosisCoordinator({ diagnoser, mode: 'auto' }, storage);
      coordinator.observeFlush([exceptionEntry('fam-A')]);
      const diagnosis = await coordinator.awaitForAlert('fam-A', 1000);
      expect(diagnosis).toBe('## cause');
    });

    it('awaitForAlert returns null when the diagnosis is slow (past the grace)', async () => {
      vi.useFakeTimers();
      const storage = await makeStorageWithException('fam-A');
      // A diagnoser that never resolves within the grace window.
      const diagnoser: ExceptionDiagnoser = {
        diagnose: () => new Promise<string>(() => {}),
      };
      const coordinator = new DiagnosisCoordinator({ diagnoser, mode: 'auto' }, storage);
      coordinator.observeFlush([exceptionEntry('fam-A')]);
      const racePromise = coordinator.awaitForAlert('fam-A', 50);
      await vi.advanceTimersByTimeAsync(50);
      expect(await racePromise).toBeNull();
    });

    it('awaitForAlert returns null for an unknown family', async () => {
      const storage = new InMemoryStorageProvider();
      const diagnoser = countingDiagnoser();
      const coordinator = new DiagnosisCoordinator({ diagnoser, mode: 'auto' }, storage);
      expect(await coordinator.awaitForAlert('never-seen', 10)).toBeNull();
    });
  });

  it('exposes the mode (default on-demand)', async () => {
    const storage = new InMemoryStorageProvider();
    const diagnoser = countingDiagnoser();
    expect(new DiagnosisCoordinator({ diagnoser }, storage).mode).toBe('on-demand');
    expect(new DiagnosisCoordinator({ diagnoser, mode: 'auto' }, storage).isAuto).toBe(true);
  });

  it('shares an injected cache so the on-demand path sees auto-mode results', async () => {
    const storage = await makeStorageWithException('fam-A');
    const cache = new DiagnosisCache();
    const diagnoser = countingDiagnoser('## shared');
    const coordinator = new DiagnosisCoordinator({ diagnoser, mode: 'auto' }, storage, { cache });
    coordinator.observeFlush([exceptionEntry('fam-A')]);
    await vi.waitFor(() => expect(cache.get('fam-A')).toBe('## shared'));
    const result = await coordinator.diagnose(exceptionEntry('fam-A'), 1);
    expect(result.cached).toBe(true);
    expect(diagnoser.calls).toHaveLength(1);
  });

  describe('organizations as tenants', () => {
    const viewOf = (id: string) => tenantViewOf({ kind: 'tenant', id }, 'tenant', 'tenantless');
    const tenancy = {
      viewOfEntry: (entry: Entry) => {
        const tag = entry.tags.find((t) => t.startsWith('tenant:'));
        return tag ? viewOf(tag.slice('tenant:'.length)) : null;
      },
    };
    function tenantException(tenant: string, message: string): Entry {
      return {
        ...exceptionEntry('fam-A', `batch-${tenant}`),
        id: `ex-${tenant}`,
        tags: [`tenant:${tenant}`],
        content: { class: 'TypeError', message, stack: 'TypeError\n  at a' },
      };
    }
    /** Echoes the message it was given, so a cross-organization diagnosis is visible. */
    const echo: ExceptionDiagnoser = { diagnose: async (context) => `cause: ${context.message}` };

    it("auto-mode: tenant B never reads the diagnosis of tenant A's occurrence", async () => {
      const a = tenantException('A', 'secret of A');
      const b = tenantException('B', 'trouble of B');
      const storage = new InMemoryStorageProvider();
      await storage.store([a, b]);
      const coordinator = new DiagnosisCoordinator({ diagnoser: echo, mode: 'auto' }, storage, {
        tenancy,
      });

      expect(await coordinator.onNewFamily(a, 1)).toBe('cause: secret of A');
      expect(await withTenantView(viewOf('B'), async () => coordinator.peekCached(b))).toBeNull();
      expect(await coordinator.awaitForAlert(b, 10)).toBeNull();
      expect(await withTenantView(viewOf('A'), async () => coordinator.peekCached(a))).toBe(
        'cause: secret of A',
      );
      // The unscoped slot, for a viewer of every organization.
      expect(coordinator.peekCached(b)).toBe('cause: secret of A');

      // B's first occurrence of the family is new for B: B gets its own diagnosis.
      expect(await coordinator.onNewFamily(b, 1)).toBe('cause: trouble of B');
      expect(await withTenantView(viewOf('B'), async () => coordinator.peekCached(b))).toBe(
        'cause: trouble of B',
      );
    });

    it("on-demand in B's view: B's batch only, never A's entries in it", async () => {
      const b = tenantException('B', 'trouble of B');
      const stray: Entry = {
        ...exceptionEntry(null, 'batch-B'),
        id: 'q-A',
        type: 'query',
        tags: ['tenant:A'],
        content: { sql: 'select a_secret' },
      };
      const storage = new InMemoryStorageProvider();
      await storage.store([b, stray]);
      const diagnoser = countingDiagnoser();
      const coordinator = new DiagnosisCoordinator({ diagnoser }, storage, { tenancy });
      await withTenantView(viewOf('B'), () => coordinator.diagnose(b, 1));
      expect(diagnoser.calls[0]?.recentQueries).toEqual([]);
      await expect(withTenantView(viewOf('A'), () => coordinator.diagnose(b, 1))).rejects.toThrow();
    });

    it('tenancy off: one slot per family', async () => {
      const a = tenantException('A', 'secret of A');
      const storage = new InMemoryStorageProvider();
      await storage.store([a]);
      const coordinator = new DiagnosisCoordinator({ diagnoser: echo, mode: 'auto' }, storage);
      await coordinator.onNewFamily(a, 1);
      expect(coordinator.peekCached(tenantException('B', 'x'))).toBe('cause: secret of A');
      expect(await coordinator.awaitForAlert('fam-A', 10)).toBe('cause: secret of A');
    });
  });
});
