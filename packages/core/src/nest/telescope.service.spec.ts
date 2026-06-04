// packages/core/src/nest/telescope.service.spec.ts
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { telescopeDump } from '../dump/telescope-dump.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

function makeService(
  storage = new InMemoryStorageProvider(),
  options: TelescopeModuleOptions = {},
) {
  const config = resolveConfig({ recorder: { flushIntervalMs: 5 } });
  const service = new TelescopeService(config, storage, options);
  return { service, storage, config };
}

describe('TelescopeService', () => {
  let active: TelescopeService | null = null;
  afterEach(async () => {
    await active?.onApplicationShutdown();
    active = null;
  });

  it('records and flushes a correlated batch on demand', async () => {
    const { service, storage } = makeService();
    active = service;
    await service.runInBatch('http', async () => {
      service.record({ type: 'request', content: { statusCode: 200 } });
      service.record({ type: 'query', content: {} });
    });
    await service.flush();
    const all = (await storage.get({})).data;
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.batchId)).size).toBe(1); // same batch
  });

  it('dump() records a dump entry with the label and value', async () => {
    const { service, storage } = makeService();
    active = service;
    service.dump({ a: 1 }, 'my-label');
    await service.flush();
    const all = (await storage.get({})).data;
    expect(all).toHaveLength(1);
    expect(all[0]?.type).toBe('dump');
    expect(all[0]?.content).toEqual({ label: 'my-label', value: { a: 1 } });
  });

  it('dump() defaults the label to null when omitted', async () => {
    const { service, storage } = makeService();
    active = service;
    service.dump('hello');
    await service.flush();
    const content = (await storage.get({})).data[0]?.content as { label: string | null };
    expect(content.label).toBeNull();
  });

  it('dump() redacts sensitive leaves of the value', async () => {
    const storage = new InMemoryStorageProvider();
    const config = resolveConfig({ recorder: { flushIntervalMs: 5 } });
    const service = new TelescopeService(config, storage, {});
    active = service;
    service.dump({ password: 'x', keep: 'ok' });
    await service.flush();
    const content = (await storage.get({})).data[0]?.content as {
      value: { password: string; keep: string };
    };
    expect(content.value.password).toBe('[REDACTED]');
    expect(content.value.keep).toBe('ok');
  });

  it('dump() correlates to the active batch', async () => {
    const { service, storage } = makeService();
    active = service;
    await service.runInBatch('http', async () => {
      service.record({ type: 'request', content: {} });
      service.dump({ debug: true }, 'in-batch');
    });
    await service.flush();
    const all = (await storage.get({})).data;
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.batchId)).size).toBe(1);
  });

  it('wires the global telescopeDump sink (no DI needed at call site)', async () => {
    const { service, storage } = makeService();
    active = service;
    telescopeDump({ via: 'global' }, 'free-fn');
    await service.flush();
    const all = (await storage.get({})).data;
    expect(all).toHaveLength(1);
    expect(all[0]?.content).toEqual({ label: 'free-fn', value: { via: 'global' } });
  });

  it('detaches the global telescopeDump sink on shutdown', async () => {
    const { service, storage } = makeService();
    service.dump('pre');
    await service.onApplicationShutdown();
    // After shutdown the sink is null; this call must be a no-op (not recorded).
    telescopeDump('post', 'after-shutdown');
    const all = (await storage.get({})).data;
    expect(
      all.some((e) => e.type === 'dump' && JSON.stringify(e.content).includes('after-shutdown')),
    ).toBe(false);
  });

  it('warns at boot when no prune is configured', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const service = new TelescopeService(resolveConfig({}), new InMemoryStorageProvider(), {});
      active = service;
      await service.onModuleInit();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('No `prune` configured'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn about prune when retention is configured', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const service = new TelescopeService(
        resolveConfig({ prune: { after: '1h' } }),
        new InMemoryStorageProvider(),
        {},
      );
      active = service;
      await service.onModuleInit();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('No `prune` configured'));
    } finally {
      warn.mockRestore();
    }
  });

  it('drains the buffer on application shutdown', async () => {
    const { service, storage } = makeService();
    service.record({ type: 'exception', content: {} });
    await service.onApplicationShutdown();
    expect((await storage.get({})).data).toHaveLength(1);
  });

  it('getMeta reports enabled watchers, dropped count, and storage ok', async () => {
    const { service } = makeService();
    active = service;
    const meta = await service.getMeta();
    expect(meta.enabled).toBe(true);
    expect(meta.droppedCount).toBe(0);
    expect(Array.isArray(meta.watchers)).toBe(true);
  });

  it('getMeta returns the configured traceLink', async () => {
    const config = resolveConfig({
      recorder: { flushIntervalMs: 5 },
      traceLink: 'https://traces.example/{traceId}/{spanId}',
    });
    const service = new TelescopeService(config, new InMemoryStorageProvider(), {});
    active = service;
    expect((await service.getMeta()).traceLink).toBe('https://traces.example/{traceId}/{spanId}');
  });

  it('getMeta reflects configured retention and sampling', async () => {
    const config = resolveConfig({
      recorder: { flushIntervalMs: 5 },
      prune: { after: '1h', keepLast: 1000 },
      sampling: { request: 0.25 },
    });
    const service = new TelescopeService(config, new InMemoryStorageProvider(), {});
    active = service;
    const meta = await service.getMeta();
    expect(meta.retention).toEqual({ afterMs: 3_600_000, keepLast: 1000 });
    expect(meta.sampling).toEqual({ request: 0.25 });
  });

  it('getMeta returns null retention when no prune configured', async () => {
    const { service } = makeService();
    active = service;
    const meta = await service.getMeta();
    expect(meta.retention).toBeNull();
    expect(meta.sampling).toEqual({});
  });

  it('getMeta returns null keepLast when prune omits it', async () => {
    const config = resolveConfig({
      recorder: { flushIntervalMs: 5 },
      prune: { after: '1h' },
    });
    const service = new TelescopeService(config, new InMemoryStorageProvider(), {});
    active = service;
    expect((await service.getMeta()).retention).toEqual({ afterMs: 3_600_000, keepLast: null });
  });

  it('getMeta returns null traceLink when unset', async () => {
    const { service } = makeService();
    active = service;
    expect((await service.getMeta()).traceLink).toBeNull();
  });

  it('getMeta returns a copy of watcher types (no internal-state leak)', async () => {
    const { service } = makeService();
    active = service;
    service.setWatchers(['request']);
    const meta = await service.getMeta();
    meta.watchers.push('hacked');
    expect((await service.getMeta()).watchers).toEqual(['request']);
  });

  it('runInBatch still runs fn but opens no batch when disabled', async () => {
    const service = new TelescopeService(
      resolveConfig({ enabled: false }),
      new InMemoryStorageProvider(),
      {},
    );
    active = service;
    const result = await service.runInBatch('http', async () => {
      expect(service.context.current()).toBeUndefined(); // no ALS batch when disabled
      return 'ran';
    });
    expect(result).toBe('ran');
  });

  it('onApplicationShutdown calls storage.close AFTER flush when module created the storage (options = {})', async () => {
    const log: string[] = [];
    const fakeStorage: StorageProvider & { close(): void } = {
      store: () => {
        log.push('store');
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
      find: () => Promise.resolve(null),
      get: () => Promise.resolve({ data: [], nextCursor: null }),
      batch: () => Promise.resolve([]),
      tags: () => Promise.resolve([]),
      prune: () => Promise.resolve(0),
      clear: () => Promise.resolve(),
      close: () => {
        log.push('close');
      },
    };
    const config = resolveConfig({ recorder: { flushIntervalMs: 5 } });
    const service = new TelescopeService(config, fakeStorage, {});
    // record so that flush does real work and we can verify ordering
    service.record({ type: 'request', content: {} });
    await service.onApplicationShutdown();
    // close must appear AFTER store (flush ran first)
    const closeIdx = log.indexOf('close');
    const storeIdx = log.indexOf('store');
    expect(closeIdx).toBeGreaterThan(-1);
    expect(storeIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(storeIdx);
  });

  it('onApplicationShutdown ALWAYS calls storage.close after flush, even for host-supplied storage', async () => {
    const closeCalled: boolean[] = [];
    const fakeStorage: StorageProvider & { close(): void } = {
      store: () => Promise.resolve(),
      update: () => Promise.resolve(),
      find: () => Promise.resolve(null),
      get: () => Promise.resolve({ data: [], nextCursor: null }),
      batch: () => Promise.resolve([]),
      tags: () => Promise.resolve([]),
      prune: () => Promise.resolve(0),
      clear: () => Promise.resolve(),
      close: () => {
        closeCalled.push(true);
      },
    };
    const config = resolveConfig({ recorder: { flushIntervalMs: 5 } });
    // Pass fakeStorage as options.storage to simulate host-supplied storage
    const service = new TelescopeService(config, fakeStorage, { storage: fakeStorage });
    await service.onApplicationShutdown();
    expect(closeCalled).toHaveLength(1);
  });

  it('onModuleInit awaits storage.init when enabled', async () => {
    const initLog: string[] = [];
    const fakeStorage: StorageProvider & { init(): void } = {
      store: () => Promise.resolve(),
      update: () => Promise.resolve(),
      find: () => Promise.resolve(null),
      get: () => Promise.resolve({ data: [], nextCursor: null }),
      batch: () => Promise.resolve([]),
      tags: () => Promise.resolve([]),
      prune: () => Promise.resolve(0),
      clear: () => Promise.resolve(),
      init: () => {
        initLog.push('init');
      },
    };
    const config = resolveConfig({ recorder: { flushIntervalMs: 5 } });
    const service = new TelescopeService(config, fakeStorage, {});
    active = service;
    await service.onModuleInit();
    expect(initLog).toEqual(['init']);
  });

  it('onModuleInit does not start (or await init) when disabled', async () => {
    const initLog: string[] = [];
    const fakeStorage: StorageProvider & { init(): void } = {
      store: () => Promise.resolve(),
      update: () => Promise.resolve(),
      find: () => Promise.resolve(null),
      get: () => Promise.resolve({ data: [], nextCursor: null }),
      batch: () => Promise.resolve([]),
      tags: () => Promise.resolve([]),
      prune: () => Promise.resolve(0),
      clear: () => Promise.resolve(),
      init: () => {
        initLog.push('init');
      },
    };
    const config = resolveConfig({ enabled: false, recorder: { flushIntervalMs: 5 } });
    const service = new TelescopeService(config, fakeStorage, {});
    active = service;
    await service.onModuleInit();
    expect(initLog).toEqual([]);
  });
});
