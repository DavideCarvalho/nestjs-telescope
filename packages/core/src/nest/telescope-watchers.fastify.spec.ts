// packages/core/src/nest/telescope-watchers.fastify.spec.ts
import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeModule } from './telescope.module.js';
import { TelescopeService } from './telescope.service.js';

@Controller('boom')
class BoomController {
  @Get()
  go(): never {
    throw new TypeError('kaboom');
  }
}

describe('Watchers (e2e, Fastify)', () => {
  let app: NestFastifyApplication;
  afterEach(async () => {
    await app?.close();
  });

  it('records and correlates request + exception on Fastify', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true })],
      controllers: [BoomController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    await app.inject({ method: 'GET', url: '/boom' }); // 500
    await app.get(TelescopeService).flush();

    const res = await app.inject({ method: 'GET', url: '/telescope/api/entries' });
    const data = JSON.parse(res.payload).data as { type: string; batchId: string }[];
    const req = data.find((e) => e.type === 'request');
    const exc = data.find((e) => e.type === 'exception');
    expect(req).toBeDefined();
    expect(exc).toBeDefined();
    expect(req?.batchId).toBe(exc?.batchId);
  });
});
