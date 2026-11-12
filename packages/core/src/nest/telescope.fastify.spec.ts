// packages/core/src/nest/telescope.fastify.spec.ts
import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { UseConsoleAuthorize } from './console-authorize.guard.js';
import { TelescopeModule } from './telescope.module.js';
import { TelescopeService } from './telescope.service.js';

describe('TelescopeModule (e2e, Fastify)', () => {
  let app: NestFastifyApplication;
  afterEach(async () => {
    await app?.close();
  });

  it('serves the same gated API on the Fastify adapter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({})],
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

describe('console authorize on Fastify', () => {
  let app: NestFastifyApplication;
  afterEach(async () => {
    await app?.close();
  });

  @Controller('ops/page')
  @UseConsoleAuthorize({ authorize: () => ({ redirectTo: '/login' }), pages: true })
  class Page {
    @Get()
    index() {
      return 'page';
    }
  }

  it('writes 403 JSON, 401 with redirectTo, and a 302 for a page navigation', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorize: () => false })],
      controllers: [Page],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const denied = await app.inject({ method: 'GET', url: '/telescope/api/meta' });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.payload)).toEqual({ error: 'forbidden' });

    const api = await app.inject({ method: 'GET', url: '/ops/page' });
    expect(api.statusCode).toBe(401);
    expect(JSON.parse(api.payload)).toEqual({ error: 'unauthenticated', redirectTo: '/login' });

    const page = await app.inject({
      method: 'GET',
      url: '/ops/page',
      headers: { accept: 'text/html' },
    });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe('/login');
  });
});
