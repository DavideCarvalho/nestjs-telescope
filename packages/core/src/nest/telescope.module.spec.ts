// packages/core/src/nest/telescope.module.spec.ts
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeModule } from './telescope.module.js';
import { TelescopeService } from './telescope.service.js';

describe('TelescopeModule (e2e, Express)', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app?.close();
  });

  it('boots, records via the service, and serves the gated API', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true })],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    const service = app.get(TelescopeService);
    await service.runInBatch('http', async () => {
      service.record({ type: 'request', content: { statusCode: 200 } });
    });
    await service.flush();

    const res = await request(app.getHttpServer()).get('/telescope/api/entries').expect(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].type).toBe('request');

    const meta = await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
    expect(meta.body.enabled).toBe(true);
  });

  it('denies the API when the authorizer returns false', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => false })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).get('/telescope/api/meta').expect(403);
  });
});
