// packages/core/src/nest/watcher-context.factory.spec.ts
import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeService } from './telescope.service.js';
import { createWatcherContext } from './watcher-context.factory.js';

describe('createWatcherContext', () => {
  it('exposes record/runInBatch/beginBatch/config/moduleRef backed by the service', async () => {
    const storage = new InMemoryStorageProvider();
    const config = resolveConfig({});
    const service = new TelescopeService(config, storage, {});
    const moduleRef = {} as ModuleRef;
    const ctx = createWatcherContext(service, config, moduleRef);

    expect(ctx.config).toBe(config);
    expect(ctx.moduleRef).toBe(moduleRef);

    // beginBatch opens a batch; records inside it correlate.
    const handle = ctx.beginBatch('queue');
    ctx.record({ type: 'job', content: {} });
    handle.end();
    await service.flush();

    const all = (await storage.get({})).data;
    expect(all).toHaveLength(1);
    expect(all[0]?.batchId).toBe(handle.id);
  });
});
