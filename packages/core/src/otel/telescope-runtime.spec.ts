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

  it.each([1, 2])(
    'suppresses tracing through the context manager of @opentelemetry/api %i.x',
    (major) => {
      const key = Symbol.for(`opentelemetry.js.api.${major}`);
      const suppressKey = Symbol.for('OpenTelemetry SDK Context Key SUPPRESS_TRACING');
      const seen: unknown[] = [];
      const makeContext = (values: Map<symbol, unknown>) => ({
        values,
        setValue(k: symbol, v: unknown) {
          return makeContext(new Map(values).set(k, v));
        },
      });
      const slot = globalThis as Record<symbol, unknown>;
      slot[key] = {
        context: {
          active: () => makeContext(new Map()),
          with: <T>(ctx: { values: Map<symbol, unknown> }, fn: () => T): T => {
            seen.push(ctx.values.get(suppressKey));
            return fn();
          },
        },
      };
      try {
        expect(runAsTelescopeWork(() => 'ok')).toBe('ok');
        expect(seen).toEqual([true]);
      } finally {
        delete slot[key];
      }
    },
  );

  it('just runs the function when no OpenTelemetry api is registered', () => {
    expect(runAsTelescopeWork(() => 42)).toBe(42);
  });
});
