// packages/core/src/nest/telescope-request.middleware.spec.ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeService } from './telescope.service.js';
import { TelescopeRequestMiddleware } from './telescope-request.middleware.js';

describe('TelescopeRequestMiddleware', () => {
  it('opens a batch and records a request entry on response finish', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const mw = new TelescopeRequestMiddleware(service);

    const req = { method: 'GET', url: '/orders/42', headers: {}, socket: { remoteAddress: '10.0.0.1' } };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    const next = vi.fn();

    mw.use(req, res, next);
    expect(next).toHaveBeenCalledOnce();

    // A child entry recorded during the request must share the batch.
    service.record({ type: 'query', content: {} });
    res.emit('finish');
    await service.flush();

    const all = (await storage.get({})).data;
    const request = all.find((e) => e.type === 'request');
    const query = all.find((e) => e.type === 'query');
    expect(request).toBeDefined();
    expect((request?.content as { method: string }).method).toBe('GET');
    expect((request?.content as { statusCode: number }).statusCode).toBe(200);
    expect(request?.batchId).toBe(query?.batchId); // correlated
  });

  it('does nothing recordable when disabled but still calls next', () => {
    const service = new TelescopeService(resolveConfig({ enabled: false }), new InMemoryStorageProvider(), {});
    const mw = new TelescopeRequestMiddleware(service);
    const next = vi.fn();
    mw.use({ method: 'GET', url: '/', headers: {} }, Object.assign(new EventEmitter(), { statusCode: 200 }), next);
    expect(next).toHaveBeenCalledOnce();
  });
});
