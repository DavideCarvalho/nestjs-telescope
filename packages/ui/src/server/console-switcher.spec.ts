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
import { type ExecutionContext, type INestApplication, UseGuards } from '@nestjs/common';
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
  it('has no switcher while telescope is alone, but ⌘K searches it per console', async () => {
    const server = await boot({ authorize: () => true });
    const res = await request(server).get('/telescope').expect(200);
    expect(configOf(res.text)).toEqual({
      base: '/telescope',
      search: { endpoint: '/telescope/api/consoles/search', self: 'telescope' },
    });
  });

  it('has no search with routes: false (telescope is not in the registry)', async () => {
    await boot({ routes: false });
    const { TelescopeUiController } = await import('./telescope-ui.controller.js');
    const page = new TelescopeUiController({ assetsDir: dir });
    expect(configOf(await page.index({}))).toEqual({ base: '/telescope' });
  });

  it('carries the endpoint and how many others are registered, as data (CSP-safe)', async () => {
    registerAviaryConsole(other('durable'));
    registerAviaryConsole(other('media'));
    const server = await boot({ path: 'ops/telescope', authorize: () => true });
    const res = await request(server).get('/ops/telescope').expect(200);
    expect(configOf(res.text)).toEqual({
      base: '/ops/telescope',
      switcher: { endpoint: '/ops/telescope/api/consoles', others: 2 },
      search: { endpoint: '/ops/telescope/api/consoles/search', self: 'telescope' },
    });
    expect(res.text).toContain('<script type="application/json" id="telescope-dashboard-config">');
    expect(res.text).toContain('src="/ops/telescope/assets/app.js"');
  });
});

describe('the sidebar footer (viewer, signOut)', () => {
  it('reads request.user structurally by default, and emits no sign-out', async () => {
    const server = await boot({
      authorize: () => true,
      // A guard stand-in: what an authentication guard would leave on the request.
      decorators: [
        UseGuards({
          canActivate: (c: ExecutionContext) => {
            const req = c.switchToHttp().getRequest<Record<string, unknown>>();
            req.user = { fullName: 'Ann Lee', email: 'ann@x.test', roles: ['admin'] };
            return true;
          },
        }),
      ],
    });
    const config = configOf((await request(server).get('/telescope').expect(200)).text);
    expect(config.viewer).toEqual({ label: 'Ann Lee', email: 'ann@x.test', role: 'admin' });
    expect(config.signOut).toBeUndefined();
  });

  it('uses the viewer and signOut options, keeping same-origin paths only', async () => {
    const server = await boot({
      authorize: () => true,
      viewer: async () => ({ label: 'Ops <team>', role: 'admin' }),
      signOut: { action: '/logout', csrfToken: () => 'tok' },
    });
    const res = await request(server).get('/telescope').expect(200);
    const config = configOf(res.text);
    expect(config.viewer).toEqual({ label: 'Ops <team>', role: 'admin' });
    expect(config.signOut).toEqual({ action: '/logout', csrfToken: 'tok' });
    // `<` never reaches the HTML raw.
    expect(res.text).not.toContain('Ops <team>');
  });

  it('falls back to the sign-out an account console announced; `false` turns it off', async () => {
    registerAviaryConsole(other('account'));
    (readAviaryConsoles() as unknown as Record<string, unknown>).account = {
      signOut: { href: '/account/logout' },
    };
    let server = await boot({ authorize: () => true });
    expect(configOf((await request(server).get('/telescope').expect(200)).text).signOut).toEqual({
      href: '/account/logout',
    });
    await app?.close();
    server = await boot({ authorize: () => true, signOut: false });
    expect(
      configOf((await request(server).get('/telescope').expect(200)).text).signOut,
    ).toBeUndefined();
    server = await boot({ authorize: () => true, signOut: 'https://evil.example/out' });
    expect(
      configOf((await request(server).get('/telescope').expect(200)).text).signOut,
    ).toBeUndefined();
  });

  it('takes viewer and signOut from forRootAsync’s factory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeUiModule.forRootAsync({
          useFactory: () => ({
            assetsDir: dir,
            authorize: () => true,
            viewer: () => ({ label: 'Bo' }),
            signOut: '/out',
          }),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    const config = configOf(
      (await request(app.getHttpServer()).get('/telescope').expect(200)).text,
    );
    expect(config.viewer).toEqual({ label: 'Bo' });
    expect(config.signOut).toEqual({ action: '/out' });
  });
});
