// @vitest-environment node
import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelescopeUiModule } from './telescope-ui.module.js';

// src/server/*.spec.ts -> ../../dist/spa (the real Vite bundle, present after build)
const realSpaDir = fileURLToPath(new URL('../../dist/spa', import.meta.url));
const built = existsSync(realSpaDir);

describe.skipIf(!built)('TelescopeUiController serves the real built bundle', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeUiModule.forRoot({ assetsDir: realSpaDir })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the real index.html referencing /telescope/assets', async () => {
    const res = await request(app.getHttpServer()).get('/telescope').expect(200);
    expect(res.text).toContain('<div id="root">');
    expect(res.text).toMatch(/\/telescope\/assets\/[\w-]+\.js/);
  });

  it('serves the real hashed JS asset referenced by index.html', async () => {
    const html = readFileSync(`${realSpaDir}/index.html`, 'utf8');
    const match = html.match(/\/telescope\/assets\/([\w-]+\.js)/);
    expect(match).toBeTruthy();
    const file = match?.[1];
    expect(file).toBeTruthy();
    const res = await request(app.getHttpServer()).get(`/telescope/assets/${file}`).expect(200);
    expect(res.header['content-type']).toContain('javascript');
  });
});
