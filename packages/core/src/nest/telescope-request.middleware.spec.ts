// packages/core/src/nest/telescope-request.middleware.spec.ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeRequestMiddleware } from './telescope-request.middleware.js';
import { TelescopeService } from './telescope.service.js';

describe('TelescopeRequestMiddleware', () => {
  it('opens a batch and records a request entry on response finish', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const mw = new TelescopeRequestMiddleware(service);

    const req = {
      method: 'GET',
      url: '/orders/42',
      headers: {},
      socket: { remoteAddress: '10.0.0.1' },
    };
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
    // The request entry groups by its normalized route family (id segment → :id).
    expect(request?.familyHash).toBe('GET /orders/:id');
  });

  it('records a non-root, prefixed-style path (regression for global-prefix capture)', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const mw = new TelescopeRequestMiddleware(service);

    const req = {
      method: 'GET',
      url: '/api/user/me',
      headers: {},
      socket: { remoteAddress: '10.0.0.1' },
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    const next = vi.fn();

    mw.use(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    res.emit('finish');
    await service.flush();

    const all = (await storage.get({})).data;
    const request = all.find((e) => e.type === 'request');
    expect(request).toBeDefined();
    expect((request?.content as { uri: string }).uri).toBe('/api/user/me');
  });

  it('skips telescope dashboard paths without beginning a batch or recording', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const beginBatch = vi.spyOn(service, 'beginBatch');
    const mw = new TelescopeRequestMiddleware(service);

    for (const url of [
      '/telescope',
      '/telescope/api/entries',
      '/telescope/api/entries?type=request',
    ]) {
      const req = {
        method: 'GET',
        url,
        headers: {},
        socket: { remoteAddress: '10.0.0.1' },
      };
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      const next = vi.fn();

      mw.use(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      res.emit('finish');
    }

    await service.flush();

    expect(beginBatch).not.toHaveBeenCalled();
    const all = (await storage.get({})).data;
    expect(all.find((e) => e.type === 'request')).toBeUndefined();
  });

  it('records the request body as payload and req.user as user (redacting secrets)', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const mw = new TelescopeRequestMiddleware(service);

    const req = {
      method: 'POST',
      url: '/login',
      headers: {},
      socket: { remoteAddress: '10.0.0.1' },
      body: { email: 'a@b.com', password: 'hunter2' },
      user: { id: 'u1', roles: ['admin'] },
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 201 });
    const next = vi.fn();

    mw.use(req, res, next);
    res.emit('finish');
    await service.flush();

    const all = (await storage.get({})).data;
    const request = all.find((e) => e.type === 'request');
    const content = request?.content as { payload: unknown; user: unknown };
    expect(content.payload).toEqual({ email: 'a@b.com', password: '[REDACTED]' });
    expect(content.user).toEqual({ id: 'u1', roles: ['admin'] });
  });

  it('uses the resolveUser override when provided', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {
      resolveUser: (request) =>
        typeof request === 'object' && request !== null && 'auth' in request
          ? (request as { auth: unknown }).auth
          : null,
    });
    const mw = new TelescopeRequestMiddleware(service);

    const req = {
      method: 'GET',
      url: '/me',
      headers: {},
      socket: { remoteAddress: '10.0.0.1' },
      user: { ignored: true },
      auth: { sub: 'custom-123' },
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    mw.use(req, res, vi.fn());
    res.emit('finish');
    await service.flush();

    const all = (await storage.get({})).data;
    const request = all.find((e) => e.type === 'request');
    expect((request?.content as { user: unknown }).user).toEqual({ sub: 'custom-123' });
  });

  it('records null payload and user when the request has neither (no throw)', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const mw = new TelescopeRequestMiddleware(service);

    const req = { method: 'GET', url: '/ping', headers: {}, socket: { remoteAddress: '10.0.0.1' } };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    mw.use(req, res, vi.fn());
    res.emit('finish');
    await service.flush();

    const all = (await storage.get({})).data;
    const content = all.find((e) => e.type === 'request')?.content as {
      payload: unknown;
      user: unknown;
    };
    expect(content.payload).toBeNull();
    expect(content.user).toBeNull();
  });

  it('does nothing recordable when disabled but still calls next', () => {
    const service = new TelescopeService(
      resolveConfig({ enabled: false }),
      new InMemoryStorageProvider(),
      {},
    );
    const mw = new TelescopeRequestMiddleware(service);
    const next = vi.fn();
    mw.use(
      { method: 'GET', url: '/', headers: {} },
      Object.assign(new EventEmitter(), { statusCode: 200 }),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
