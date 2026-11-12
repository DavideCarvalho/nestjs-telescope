// packages/core/src/otel/telescope-runtime.spec.ts
import { describe, expect, it } from 'vitest';
import {
  TELESCOPE_RUNTIME_KEY,
  asTelescopeWorkStorage,
  isTelescopeWork,
  markCoveredByTelescope,
  runAsTelescopeWork,
  runCoveredByTelescope,
  telescopeRuntime,
} from './telescope-runtime.js';

describe('telescope runtime', () => {
  it('lives in a global slot shared by every copy of the package', () => {
    const runtime = telescopeRuntime();
    expect((globalThis as Record<symbol, unknown>)[TELESCOPE_RUNTIME_KEY]).toBe(runtime);
    expect(telescopeRuntime()).toBe(runtime);
  });

  it('keeps an operation covered while any watcher holds it', () => {
    const covered = telescopeRuntime().covered;
    const a = markCoveredByTelescope('redis');
    const b = markCoveredByTelescope('redis');
    expect(covered.get('redis')).toBe(2);
    a();
    a();
    expect(covered.get('redis')).toBe(1);
    b();
    expect(covered.has('redis')).toBe(false);
  });

  it('tracks telescope work and covered calls across awaits', async () => {
    const runtime = telescopeRuntime();
    expect(isTelescopeWork()).toBe(false);
    await runAsTelescopeWork(async () => {
      await Promise.resolve();
      expect(isTelescopeWork()).toBe(true);
      expect(runtime.isTelescopeWork()).toBe(true);
    });
    await runCoveredByTelescope(async () => {
      await Promise.resolve();
      expect(runtime.isCoveredCall()).toBe(true);
    });
    expect(runtime.isCoveredCall()).toBe(false);
  });

  it('wraps a storage so its methods run as telescope work on the real instance', async () => {
    class Store {
      #rows: number[] = [];
      seen: boolean[] = [];
      async store(row: number): Promise<void> {
        await Promise.resolve();
        this.seen.push(isTelescopeWork());
        this.#rows.push(row);
      }
      get count(): number {
        return this.#rows.length;
      }
    }
    const store = asTelescopeWorkStorage(new Store());
    await store.store(1);
    expect(store.count).toBe(1);
    expect(store.seen).toEqual([true]);
    expect(store).toBeInstanceOf(Store);
    expect(store.store).toBe(store.store);
  });
});
