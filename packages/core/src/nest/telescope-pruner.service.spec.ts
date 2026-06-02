// packages/core/src/nest/telescope-pruner.service.spec.ts
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
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

    // Should not throw
    expect(() => pruner.onApplicationBootstrap()).not.toThrow();

    // Advance past the interval so the prune callback fires
    await vi.advanceTimersByTimeAsync(intervalMs + 10);

    // The logger.warn must have been called with the error message
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));

    pruner.onApplicationShutdown();
    warnSpy.mockRestore();
  });
});
