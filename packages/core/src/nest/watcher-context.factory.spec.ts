// packages/core/src/nest/watcher-context.factory.spec.ts
import { ForbiddenException } from '@nestjs/common';
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

  it('exposes recordException, recording into the active batch', async () => {
    const storage = new InMemoryStorageProvider();
    const config = resolveConfig({});
    const service = new TelescopeService(config, storage, {});
    const ctx = createWatcherContext(service, config, {} as ModuleRef);

    const handle = ctx.beginBatch('queue');
    ctx.recordException?.(new TypeError('job blew up'), { context: { queue: 'mail' } });
    handle.end();
    await service.flush();

    const entries = (await storage.get({ type: 'exception' })).data;
    expect(entries).toHaveLength(1);
    // The batch is the correlation unit: an exception recorded off the request
    // path is only useful if it lands in the job's batch, not on its own.
    expect(entries[0]?.batchId).toBe(handle.id);
    expect(entries[0]?.origin).toBe('queue');
    expect(entries[0]?.familyHash).toMatch(/^TypeError:job blew up:at /);
  });

  // The 4xx policy is the interceptor's, and it has to hold on every door —
  // hosts reuse NotFoundException in services that both a controller and a
  // worker call, and a retrying queue must not be able to page on-call through
  // the back door the front door was hardened against.
  it('applies the same 4xx control-flow skip through recordException', async () => {
    const storage = new InMemoryStorageProvider();
    const config = resolveConfig({});
    const service = new TelescopeService(config, storage, {});
    const ctx = createWatcherContext(service, config, {} as ModuleRef);

    ctx.recordException?.(new ForbiddenException('nope'));
    await service.flush();

    expect((await storage.get({ type: 'exception' })).data).toHaveLength(0);
  });

  it('honours the captureHttp4xx escape hatch through recordException', async () => {
    const storage = new InMemoryStorageProvider();
    const config = resolveConfig({});
    const service = new TelescopeService(config, storage, {
      exceptions: { captureHttp4xx: true },
    });
    const ctx = createWatcherContext(service, config, {} as ModuleRef);

    ctx.recordException?.(new ForbiddenException('nope'));
    await service.flush();

    expect((await storage.get({ type: 'exception' })).data).toHaveLength(1);
  });
});
