import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { readTableQuery } from '../extension/table-query.js';
import { defineTelescopeExtension } from '../extension/types.js';
import { TelescopeModule } from './telescope.module.js';

/** What the paged table provider was last called with. */
let lastTableQuery: Record<string, unknown> | undefined;

const ext = defineTelescopeExtension({
  name: 'demo',
  dashboards: () => [
    {
      id: 'demo.page',
      label: 'Demo',
      panels: [],
      sections: [
        {
          panels: [
            {
              kind: 'table',
              title: 'Runs',
              paged: true,
              data: { provider: 'demo.table', query: { scope: 'all' } },
              columns: [
                { key: 'name', label: 'Name', sortable: true, filterable: true },
                { key: 'status', label: 'Status', filterable: true },
              ],
            },
          ],
        },
      ],
    },
  ],
  dataProviders: () => [
    { name: 'demo.ok', resolve: async (query) => ({ value: (query?.n as number) ?? 0 }) },
    {
      // A provider of the unchanged SPI: reads `readTableQuery`, answers `{ rows, total, page, limit }`.
      name: 'demo.table',
      resolve: async (query) => {
        lastTableQuery = query;
        const { page = 1, limit = 50 } = readTableQuery(query);
        return { rows: [{ name: 'a' }], total: 120, page, limit };
      },
    },
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

  it('translates a table request to the provider SPI and its page to the offset envelope', async () => {
    app = await makeApp();
    const res = await request(app.getHttpServer())
      .get(
        '/telescope/api/ext/demo/data/demo.table?scope=all&page=2&size=25&sort=-name&filter[status]=failed',
      )
      .expect(200);
    expect(lastTableQuery).toEqual({
      scope: 'all',
      page: 2,
      limit: 25,
      sort: 'name',
      dir: 'desc',
      'filter.status': 'failed',
    });
    expect(readTableQuery(lastTableQuery)).toEqual({
      page: 2,
      limit: 25,
      sort: { key: 'name', dir: 'desc' },
      filters: { status: 'failed' },
    });
    expect(res.body).toEqual({
      data: [{ name: 'a' }],
      meta: { total: 120, perPage: 25, currentPage: 2, lastPage: 5, firstPage: 1 },
    });
  });

  it('caps size at 500', async () => {
    app = await makeApp();
    const res = await request(app.getHttpServer())
      .get('/telescope/api/ext/demo/data/demo.table?page=1&size=100000')
      .expect(200);
    expect(lastTableQuery).toMatchObject({ limit: 500 });
    expect(res.body.meta.perPage).toBe(500);
  });

  it.each([
    ['sort=-status', /Unknown sort field "status"/],
    ['filter[nope]=x', /unknown field "nope"/],
    ['page=1&limit=10', /"size"/],
    ['sort=name&dir=desc', /sort=-column/],
    ['filter.status=failed', /filter\[status\]/],
    ['page=0', /page/],
  ])('rejects %s with a 400', async (qs, message) => {
    app = await makeApp();
    const res = await request(app.getHttpServer())
      .get(`/telescope/api/ext/demo/data/demo.table?${qs}`)
      .expect(400);
    expect(res.body.message).toMatch(message);
  });
});
