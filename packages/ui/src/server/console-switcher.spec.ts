import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AVIARY_CONSOLES_SLOT,
  type AviaryConsoleEntry,
  authorizeByToken,
  readAviaryConsoles,
  registerAviaryConsole,
} from '@dudousxd/nestjs-telescope';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelescopeUiModule } from './telescope-ui.module.js';
import type { TelescopeUiModuleOptions } from './telescope-ui.options.js';

const TOKEN = 'console-token-123';
const holder = globalThis as Record<symbol, unknown>;

function other(id: string): AviaryConsoleEntry {
  return {
    id,
    title: id,
    icon: 'generic',
    path: `/${id}`,
    order: 50,
    authorize: async () => ({ allowed: true }),
  };
}

function ctx(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({}) }),
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

let dir: string;
let app: INestApplication | undefined;

async function boot(options: TelescopeUiModuleOptions) {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeUiModule.forRoot({ assetsDir: dir, ...options })],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app.getHttpServer();
}

beforeEach(() => {
  delete holder[AVIARY_CONSOLES_SLOT];
  dir = mkdtempSync(join(tmpdir(), 'tele-ui-switcher-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><script type="module" src="/telescope/assets/app.js"></script></head><body></body></html>',
  );
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function configOf(html: string): Record<string, unknown> {
  const match = html.match(
    /<script type="application\/json" id="telescope-dashboard-config">([^<]*)<\/script>/,
  );
  if (!match?.[1]) throw new Error('no config block');
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe('the telescope console in the switcher', () => {
  it('registers at its page path, gated by the page’s authorize, and leaves on close', async () => {
    await boot({ path: 'ops/telescope', authorize: authorizeByToken({ token: TOKEN }) });
    const [telescope] = readAviaryConsoles()?.entries ?? [];
    expect(telescope).toMatchObject({
      id: 'telescope',
      title: 'Telescope',
      icon: 'telescope',
      order: 20,
      path: '/ops/telescope',
    });
    expect((await telescope?.authorize(ctx({ authorization: `Bearer ${TOKEN}` })))?.allowed).toBe(
      true,
    );
    expect((await telescope?.authorize(ctx({})))?.allowed).toBe(false);
    await app?.close();
    app = undefined;
    expect(readAviaryConsoles()?.entries).toEqual([]);
  });

  it('does not register with routes: false', async () => {
    await boot({ routes: false });
    expect(readAviaryConsoles()?.entries ?? []).toEqual([]);
  });
});

describe('the shell’s config block', () => {
  it('has no switcher while telescope is alone', async () => {
    const server = await boot({ authorize: () => true });
    const res = await request(server).get('/telescope').expect(200);
    expect(configOf(res.text)).toEqual({ base: '/telescope' });
  });

  it('carries the endpoint and how many others are registered, as data (CSP-safe)', async () => {
    registerAviaryConsole(other('durable'));
    registerAviaryConsole(other('media'));
    const server = await boot({ path: 'ops/telescope', authorize: () => true });
    const res = await request(server).get('/ops/telescope').expect(200);
    expect(configOf(res.text)).toEqual({
      base: '/ops/telescope',
      switcher: { endpoint: '/ops/telescope/api/consoles', others: 2 },
    });
    expect(res.text).toContain('<script type="application/json" id="telescope-dashboard-config">');
    expect(res.text).toContain('src="/ops/telescope/assets/app.js"');
  });
});
