import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { defineTelescopeExtension } from '../extension/types.js';
import { TelescopeModule } from './telescope.module.js';

describe('extension watchers reach registration + /meta watchers', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('registers an extension watcher and lists its type in meta.watchers', async () => {
    let registered = false;
    const ext = defineTelescopeExtension({
      name: 'demo',
      watchers: () => [{ type: 'demo', register: () => { registered = true; } }],
      entryTypes: () => [{ id: 'demo', label: 'Demo', dot: 'bg-amber-400' }],
    });
    app = await makeApp({ extensions: [ext] });
    const meta = await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
    expect(registered).toBe(true);
    expect(meta.body.watchers).toContain('demo');
  });

  it('exposes extension entry types and dashboards in meta', async () => {
    const ext = defineTelescopeExtension({
      name: 'demo2',
      entryTypes: () => [{ id: 'demo2', label: 'Demo2', dot: 'bg-sky-400' }],
      dashboards: () => [{
        id: 'demo2.page',
        label: 'Demo2 Page',
        panels: [{ kind: 'stat', title: 'Total', data: { provider: 'demo2.total' } }],
      }],
    });
    app = await makeApp({ extensions: [ext] });
    const meta = await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
    expect(meta.body.entryTypes).toContainEqual({ id: 'demo2', label: 'Demo2', dot: 'bg-sky-400' });
    expect(meta.body.dashboards).toContainEqual({
      id: 'demo2.page',
      label: 'Demo2 Page',
      panels: [{ kind: 'stat', title: 'Total', data: { provider: 'demo2.total' } }],
    });
  });

  async function makeApp(extra: Record<string, unknown>): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          ...extra,
        }),
      ],
    }).compile();
    const a = moduleRef.createNestApplication();
    await a.init();
    return a;
  }
});
