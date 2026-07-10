// packages/core/src/nest/telescope-request.middleware.spec.ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeRequestMiddleware } from './telescope-request.middleware.js';
import type { TelescopeHttpRequest, TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

/** Builds a minimal request/response pair, drives it through the middleware,
 *  flushes, and returns the recorded `request` entry's `content`. */
async function captureRequestEntry(
  mw: TelescopeRequestMiddleware,
  service: TelescopeService,
  storage: InMemoryStorageProvider,
  req: Record<string, unknown>,
  statusCode = 200,
): Promise<{ payload: unknown; method: string; statusCode: number; durationMs: number }> {
  const res = Object.assign(new EventEmitter(), { statusCode });
  mw.use({ socket: { remoteAddress: '10.0.0.1' }, ...req }, res, vi.fn());
  res.emit('finish');
  await service.flush();
  const all = (await storage.get({})).data;
  const entry = all.find((e) => e.type === 'request');
  if (entry === undefined) throw new Error('expected a request entry to be recorded');
  const content = entry.content as {
    payload: unknown;
    method: string;
    statusCode: number;
  };
  return { ...content, durationMs: entry.durationMs ?? 0 };
}

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

  it('tags a replayed request (x-telescope-replay header) with `replay`', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const mw = new TelescopeRequestMiddleware(service);

    const req = {
      method: 'GET',
      url: '/orders/42',
      headers: { 'x-telescope-replay': '1' },
      socket: { remoteAddress: '10.0.0.1' },
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    mw.use(req, res, vi.fn());
    res.emit('finish');
    await service.flush();

    const request = (await storage.get({})).data.find((e) => e.type === 'request');
    expect(request?.tags).toContain('replay');
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

describe('TelescopeRequestMiddleware requestCapture (pre-record body gate)', () => {
  it('defaults: a body over 128 KiB (via content-length) is skipped without any option set', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const mw = new TelescopeRequestMiddleware(service);

    const oversizedBytes = 131_072 + 1;
    const content = await captureRequestEntry(mw, service, storage, {
      method: 'POST',
      url: '/upload',
      headers: { 'content-length': String(oversizedBytes) },
      body: { small: 'this body itself is tiny' },
    });

    expect(content.payload).toBe(`[Skipped: ${oversizedBytes} bytes > 131072 bytes]`);
    expect(content.method).toBe('POST');
    expect(content.statusCode).toBe(200);
  });

  it('defaults: the default binary content-type list skips a body with no explicit config', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const mw = new TelescopeRequestMiddleware(service);

    const content = await captureRequestEntry(mw, service, storage, {
      method: 'PATCH',
      url: '/tus/uploads/abc',
      headers: { 'content-type': 'application/offset+octet-stream' },
      body: Buffer.alloc(10),
    });

    expect(content.payload).toBe('[Skipped: application/offset+octet-stream]');
  });

  it('size gate: content-length header over maxBodyBytes skips, entry still records status/duration', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const options: TelescopeModuleOptions = { requestCapture: { maxBodyBytes: 10 } };
    const mw = new TelescopeRequestMiddleware(service, undefined, options);

    const content = await captureRequestEntry(
      mw,
      service,
      storage,
      {
        method: 'POST',
        url: '/orders',
        headers: { 'content-length': '1000' },
        body: { small: 'x' },
      },
      201,
    );

    expect(content.payload).toBe('[Skipped: 1000 bytes > 10 bytes]');
    expect(content.method).toBe('POST');
    expect(content.statusCode).toBe(201);
    expect(content.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('size gate: string body length is used when content-length is absent', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const options: TelescopeModuleOptions = { requestCapture: { maxBodyBytes: 100 } };
    const mw = new TelescopeRequestMiddleware(service, undefined, options);

    const content = await captureRequestEntry(mw, service, storage, {
      method: 'POST',
      url: '/notes',
      headers: {},
      body: 'x'.repeat(200),
    });

    expect(content.payload).toBe('[Skipped: 200 bytes > 100 bytes]');
  });

  it('size gate: Buffer body length is used when content-length is absent', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const options: TelescopeModuleOptions = { requestCapture: { maxBodyBytes: 100 } };
    const mw = new TelescopeRequestMiddleware(service, undefined, options);

    const content = await captureRequestEntry(mw, service, storage, {
      method: 'POST',
      url: '/notes',
      headers: {},
      body: Buffer.alloc(200),
    });

    expect(content.payload).toBe('[Skipped: 200 bytes > 100 bytes]');
  });

  it('size gate: a parsed-object body WITHOUT content-length passes through untouched (no stringify measuring)', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    // A tiny cap that WOULD trip if the object were stringified to measure it.
    const options: TelescopeModuleOptions = { requestCapture: { maxBodyBytes: 10 } };
    const mw = new TelescopeRequestMiddleware(service, undefined, options);

    const body = { note: 'x'.repeat(1_000) };
    const content = await captureRequestEntry(mw, service, storage, {
      method: 'POST',
      url: '/notes',
      headers: {},
      body,
    });

    expect(content.payload).toEqual(body);
  });

  it('content-type gate: a string pattern matches as a case-insensitive prefix', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const options: TelescopeModuleOptions = {
      requestCapture: { skipBodyContentTypes: ['MULTIPART/form-data'] },
    };
    const mw = new TelescopeRequestMiddleware(service, undefined, options);

    const content = await captureRequestEntry(mw, service, storage, {
      method: 'POST',
      url: '/avatar',
      headers: { 'content-type': 'multipart/form-data; boundary=abc123' },
      body: { ignored: true },
    });

    expect(content.payload).toBe('[Skipped: multipart/form-data; boundary=abc123]');
  });

  it('content-type gate: a RegExp pattern is tested against the raw header value', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const options: TelescopeModuleOptions = {
      requestCapture: { skipBodyContentTypes: [/^image\//] },
    };
    const mw = new TelescopeRequestMiddleware(service, undefined, options);

    const content = await captureRequestEntry(mw, service, storage, {
      method: 'POST',
      url: '/avatar',
      headers: { 'content-type': 'image/png' },
      body: Buffer.alloc(4),
    });

    expect(content.payload).toBe('[Skipped: image/png]');
  });

  it('skipBody predicate: skips matching requests and receives a typed TelescopeHttpRequest (no manual cast)', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    // Typed `TelescopeHttpRequest` param — headers/url read directly, no `as`.
    const skipBody = (request: TelescopeHttpRequest): boolean => request.url === '/tus/uploads/1';
    const options: TelescopeModuleOptions = { requestCapture: { skipBody } };
    const mw = new TelescopeRequestMiddleware(service, undefined, options);

    const skipped = await captureRequestEntry(mw, service, storage, {
      method: 'PATCH',
      url: '/tus/uploads/1',
      headers: {},
      body: { chunk: 'data' },
    });
    expect(skipped.payload).toBe('[Skipped: skipBody predicate]');

    const storageForOther = new InMemoryStorageProvider();
    const serviceForOther = new TelescopeService(resolveConfig({}), storageForOther, {});
    const mwForOther = new TelescopeRequestMiddleware(serviceForOther, undefined, options);
    const notSkipped = await captureRequestEntry(mwForOther, serviceForOther, storageForOther, {
      method: 'PATCH',
      url: '/tus/uploads/2',
      headers: {},
      body: { chunk: 'data' },
    });
    expect(notSkipped.payload).toEqual({ chunk: 'data' });
  });

  it('gates disabled (maxBodyBytes: false, empty skipBodyContentTypes) preserve current (ungated) behavior', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const options: TelescopeModuleOptions = {
      requestCapture: { maxBodyBytes: false, skipBodyContentTypes: [] },
    };
    const mw = new TelescopeRequestMiddleware(service, undefined, options);

    // A `content-length` far over the default cap and a content-type that's in
    // the DEFAULT skip list — with both gates explicitly disabled, neither
    // should trip. (The body itself stays well under the Recorder's OWN
    // `maxStringLength` bound so this isolates the requestCapture gate from
    // that unrelated, pre-existing redaction bound.)
    const body = 'small body, oversized content-length header, multipart content-type';
    const content = await captureRequestEntry(mw, service, storage, {
      method: 'POST',
      url: '/upload',
      headers: {
        'content-length': '9999999',
        'content-type': 'multipart/form-data; boundary=abc',
      },
      body,
    });

    expect(content.payload).toBe(body);
  });
});
