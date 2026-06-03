import 'reflect-metadata';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelescopeUiModule } from './telescope-ui.module.js';

describe('TelescopeUiController under a custom path', () => {
  let app: INestApplication;
  const dir = mkdtempSync(join(tmpdir(), 'tele-ui-path-'));

  beforeAll(async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html><head><script type="module" src="/telescope/assets/app.js"></script><link rel="stylesheet" href="/telescope/assets/app.css"></head><body><div id="root"></div></body></html>',
    );
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');

    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeUiModule.forRoot({ assetsDir: dir, path: 'observability' })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves index.html at the custom path and 404s the default', async () => {
    const res = await request(app.getHttpServer()).get('/observability').expect(200);
    expect(res.text).toContain('<div id="root">');
    await request(app.getHttpServer()).get('/telescope').expect(404);
  });

  it('rewrites the asset base to the custom path', async () => {
    const res = await request(app.getHttpServer()).get('/observability').expect(200);
    expect(res.text).toContain('/observability/assets/app.js');
    expect(res.text).not.toContain('/telescope/assets/app.js');
  });

  it('injects window.__TELESCOPE_BASE__ for the client', async () => {
    const res = await request(app.getHttpServer()).get('/observability').expect(200);
    expect(res.text).toContain('window.__TELESCOPE_BASE__ = "/observability"');
  });

  it('serves assets under the custom path', async () => {
    const res = await request(app.getHttpServer()).get('/observability/assets/app.js').expect(200);
    expect(res.header['content-type']).toContain('javascript');
  });

  it('still rejects path traversal under the custom path', async () => {
    await request(app.getHttpServer())
      .get('/observability/assets/..%2f..%2fpackage.json')
      .expect(404);
  });
});

describe('TelescopeUiController default path output is unchanged', () => {
  let app: INestApplication;
  const dir = mkdtempSync(join(tmpdir(), 'tele-ui-default-'));

  beforeAll(async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html><head><script src="/telescope/assets/app.js"></script></head><body></body></html>',
    );

    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeUiModule.forRoot({ assetsDir: dir })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('keeps /telescope/assets and injects the default base', async () => {
    const res = await request(app.getHttpServer()).get('/telescope').expect(200);
    expect(res.text).toContain('/telescope/assets/app.js');
    expect(res.text).toContain('window.__TELESCOPE_BASE__ = "/telescope"');
  });
});
