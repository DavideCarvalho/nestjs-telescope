import 'reflect-metadata';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DynamicModule, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelescopeUiModule } from './telescope-ui.module.js';

/**
 * forRootAsync mirrors the core TelescopeModule convention: DI-driven options
 * resolved via imports/inject/useFactory, applying the same options as forRoot
 * (assetsDir). The mount `path` is bound at module-build time, so — exactly like
 * core — it is passed statically on the config object, not via the factory.
 */
describe('TelescopeUiModule.forRootAsync', () => {
  let app: INestApplication;
  const dir = mkdtempSync(join(tmpdir(), 'tele-ui-async-'));

  const CONFIG_TOKEN = Symbol('UI_CONFIG_SOURCE');

  @Module({
    providers: [{ provide: CONFIG_TOKEN, useValue: { assetsDir: dir } }],
    exports: [CONFIG_TOKEN],
  })
  class ConfigModule {}

  beforeAll(async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html><head><script type="module" src="/telescope/assets/app.js"></script></head><body><div id="root"></div></body></html>',
    );
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');

    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeUiModule.forRootAsync({
          imports: [ConfigModule],
          inject: [CONFIG_TOKEN],
          useFactory: (cfg: { assetsDir: string }) => ({ assetsDir: cfg.assetsDir }),
          path: 'observability',
        }) as DynamicModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('applies async-resolved assetsDir and serves index.html at the static path', async () => {
    const res = await request(app.getHttpServer()).get('/observability').expect(200);
    expect(res.text).toContain('<div id="root">');
    await request(app.getHttpServer()).get('/telescope').expect(404);
  });

  it('rewrites the asset base to the custom path', async () => {
    const res = await request(app.getHttpServer()).get('/observability').expect(200);
    expect(res.text).toContain('/observability/assets/app.js');
  });
});
