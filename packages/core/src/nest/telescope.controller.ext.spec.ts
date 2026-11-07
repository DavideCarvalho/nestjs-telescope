import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { defineTelescopeExtension } from '../extension/types.js';
import { TelescopeModule } from './telescope.module.js';

const ext = defineTelescopeExtension({
  name: 'demo',
  dataProviders: () => [
    { name: 'demo.ok', resolve: async (query) => ({ value: (query?.n as number) ?? 0 }) },
    {
      name: 'demo.boom',
      resolve: async () => {
        throw new Error('kaboom');
      },
    },
  ],
});

async function makeApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TelescopeModule.forRoot({
        enabled: true,
        extensions: [ext],
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('GET /telescope/api/ext/:ext/data/:provider', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('routes to the named provider and passes the query', async () => {
    app = await makeApp();
    const res = await request(app.getHttpServer())
      .get('/telescope/api/ext/demo/data/demo.ok?n=7')
      .expect(200);
    expect(res.body).toEqual({ value: '7' });
  });

  it('returns 404 for an unknown provider', async () => {
    app = await makeApp();
    await request(app.getHttpServer()).get('/telescope/api/ext/demo/data/nope').expect(404);
  });

  it('returns 404 when :ext does not own the provider', async () => {
    app = await makeApp();
    await request(app.getHttpServer()).get('/telescope/api/ext/wrong/data/demo.ok').expect(404);
  });

  it('returns a 502 error payload when the provider throws', async () => {
    app = await makeApp();
    const res = await request(app.getHttpServer())
      .get('/telescope/api/ext/demo/data/demo.boom')
      .expect(502);
    expect(res.body.message).toMatch(/kaboom/);
  });
});
