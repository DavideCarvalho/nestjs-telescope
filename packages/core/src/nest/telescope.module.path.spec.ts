// packages/core/src/nest/telescope.module.path.spec.ts
import { EventEmitter } from 'node:events';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeRequestMiddleware } from './telescope-request.middleware.js';
import { TelescopeModule } from './telescope.module.js';
import { TelescopeService } from './telescope.service.js';

describe('TelescopeModule configurable path (e2e, Express)', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app?.close();
  });

  it('mounts the API under a custom path and 404s the default /telescope/api', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true, path: 'observability' })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const service = app.get(TelescopeService);
    service.record({ type: 'request', content: { statusCode: 200 } });
    await service.flush();

    const res = await request(app.getHttpServer()).get('/observability/api/meta').expect(200);
    expect(res.body.enabled).toBe(true);

    const entries = await request(app.getHttpServer())
      .get('/observability/api/entries')
      .expect(200);
    expect(entries.body.data.length).toBe(1);

    await request(app.getHttpServer()).get('/telescope/api/meta').expect(404);
  });

  it('normalizes a slash-wrapped path option', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true, path: '/obs/' })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).get('/obs/api/meta').expect(200);
  });

  it('keeps the default /telescope/api when path is unset', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
  });
});

describe('TelescopeRequestMiddleware skip honors the configured path', () => {
  function recordOnce(service: TelescopeService, url: string): void {
    const mw = new TelescopeRequestMiddleware(service);
    const req = { method: 'GET', url, headers: {}, socket: { remoteAddress: '10.0.0.1' } };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    mw.use(req, res, () => {});
    res.emit('finish');
  }

  it('skips the configured path and records the former default /telescope', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({ path: 'observability' }), storage, {});
    const beginBatch = vi.spyOn(service, 'beginBatch');

    recordOnce(service, '/observability/api/entries');
    recordOnce(service, '/telescope/api/entries');
    await service.flush();

    // The custom path is skipped; /telescope is no longer special and gets recorded.
    expect(beginBatch).toHaveBeenCalledTimes(1);
    const all = (await storage.get({})).data;
    const requests = all.filter((entry) => entry.type === 'request');
    expect(requests.length).toBe(1);
    expect((requests[0]?.content as { uri: string }).uri).toBe('/telescope/api/entries');
  });
});
