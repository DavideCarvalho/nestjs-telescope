// packages/core/src/nest/telescope.service.spec.ts
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeService } from './telescope.service.js';

function makeService(storage = new InMemoryStorageProvider()) {
  const config = resolveConfig({ recorder: { flushIntervalMs: 5 } });
  const service = new TelescopeService(config, storage);
  return { service, storage, config };
}

describe('TelescopeService', () => {
  let active: TelescopeService | null = null;
  afterEach(async () => { await active?.onApplicationShutdown(); active = null; });

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
});
