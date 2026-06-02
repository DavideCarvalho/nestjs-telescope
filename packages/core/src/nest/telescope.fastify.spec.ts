import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
// packages/core/src/nest/telescope.fastify.spec.ts
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeModule } from './telescope.module.js';
import { TelescopeService } from './telescope.service.js';

describe('TelescopeModule (e2e, Fastify)', () => {
  let app: NestFastifyApplication;
  afterEach(async () => {
    await app?.close();
  });

  it('serves the same gated API on the Fastify adapter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true })],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const service = app.get(TelescopeService);
    service.record({ type: 'request', content: { statusCode: 200 } });
    await service.flush();

    const res = await app.inject({ method: 'GET', url: '/telescope/api/entries' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.length).toBe(1);
  });
});
