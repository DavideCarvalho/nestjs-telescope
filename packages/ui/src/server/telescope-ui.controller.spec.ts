import 'reflect-metadata';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelescopeUiModule } from './telescope-ui.module.js';

describe('TelescopeUiController', () => {
  let app: INestApplication;
  const dir = mkdtempSync(join(tmpdir(), 'tele-ui-'));

  beforeAll(async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Telescope</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'assets', 'app.css'), 'body{}');

    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeUiModule.forRoot({ assetsDir: dir })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves index.html at /telescope', async () => {
    const res = await request(app.getHttpServer()).get('/telescope').expect(200);
    expect(res.header['content-type']).toContain('text/html');
    expect(res.text).toContain('Telescope');
  });

  it('serves a js asset with the right content-type', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/assets/app.js').expect(200);
    expect(res.header['content-type']).toContain('javascript');
    expect(res.text).toContain('console.log');
  });

  it('serves a css asset', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/assets/app.css').expect(200);
    expect(res.header['content-type']).toContain('css');
  });

  it('rejects path traversal', async () => {
    await request(app.getHttpServer()).get('/telescope/assets/..%2f..%2fpackage.json').expect(404);
  });

  it('404s an unknown asset', async () => {
    await request(app.getHttpServer()).get('/telescope/assets/missing.js').expect(404);
  });
});
