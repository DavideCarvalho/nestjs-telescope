// E2E against the REAL `@nestjs/authorization` (deny-by-default global guard).
import 'reflect-metadata';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import { Controller, type DynamicModule, type INestApplication, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TelescopeUiController } from './telescope-ui.controller.js';
import { TelescopeUiModule } from './telescope-ui.module.js';

type User = { id: string; admin: boolean };

@Policy()
class ConsolePolicy {
  view(user: User | null): boolean {
    return user?.admin === true;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'tele-ui-authz-'));
let app: INestApplication | undefined;

beforeAll(() => {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(imports: DynamicModule[], controllers: Type[] = []): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports,
    controllers,
    providers: [ConsolePolicy],
  }).compile();
  app = moduleRef.createNestApplication();
  app.use(
    (req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => {
      const raw = req.headers['x-user'];
      if (raw) req.user = JSON.parse(raw);
      next();
    },
  );
  await app.init();
  return app;
}

function get(target: INestApplication, url: string, user?: User) {
  const req = request(target.getHttpServer()).get(url);
  return user ? req.set('x-user', JSON.stringify(user)) : req;
}

describe('TelescopeUiModule under @nestjs/authorization', () => {
  it('(a) serves the page and assets with the global guard on and no decorators', async () => {
    const target = await boot([
      AuthorizationModule.forRoot(),
      TelescopeUiModule.forRoot({ assetsDir: dir }),
    ]);
    await get(target, '/telescope').expect(200);
    await get(target, '/telescope/assets/app.js').expect(200);
  });

  it('(b) enforces a Can() passed in decorators: guest 401, denied 403, allowed 200', async () => {
    const target = await boot([
      AuthorizationModule.forRoot(),
      TelescopeUiModule.forRoot({ assetsDir: dir, decorators: [Can(ConsolePolicy, 'view')] }),
    ]);
    await get(target, '/telescope').expect(401);
    await get(target, '/telescope', { id: 'u', admin: false }).expect(403);
    await get(target, '/telescope/assets/app.js', { id: 'u', admin: false }).expect(403);
    await get(target, '/telescope', { id: 'a', admin: true }).expect(200);
  });

  it('(b) forRootAsync takes decorators as a static top-level option', async () => {
    const target = await boot([
      AuthorizationModule.forRoot(),
      TelescopeUiModule.forRootAsync({
        useFactory: () => ({ assetsDir: dir }),
        decorators: [Can(ConsolePolicy, 'view')],
      }),
    ]);
    await get(target, '/telescope', { id: 'u', admin: false }).expect(403);
    await get(target, '/telescope', { id: 'a', admin: true }).expect(200);
  });

  it('(c) decorators from one registration do not leak into the next', async () => {
    const first = await boot([
      AuthorizationModule.forRoot(),
      TelescopeUiModule.forRoot({ assetsDir: dir, decorators: [Can(ConsolePolicy, 'view')] }),
    ]);
    await get(first, '/telescope', { id: 'u', admin: false }).expect(403);
    await first.close();

    const second = await boot([
      AuthorizationModule.forRoot(),
      TelescopeUiModule.forRoot({ assetsDir: dir }),
    ]);
    await get(second, '/telescope', { id: 'u', admin: false }).expect(200);
    expect(Reflect.getMetadata('authorization:can', TelescopeUiController)).toBeUndefined();
  });

  it('routes: false mounts nothing; a developer-mounted subclass protected with @Can serves the page', async () => {
    @Can(ConsolePolicy, 'view')
    @Controller('ops/telescope')
    class ConsolePage extends TelescopeUiController {}

    expect(TelescopeUiModule.forRoot({ routes: false }).controllers).toEqual([]);
    expect(
      TelescopeUiModule.forRootAsync({ useFactory: () => ({}), routes: false }).controllers,
    ).toEqual([]);

    const target = await boot(
      [
        AuthorizationModule.forRoot(),
        TelescopeUiModule.forRoot({ assetsDir: dir, path: 'ops/telescope', routes: false }),
      ],
      [ConsolePage],
    );
    await get(target, '/telescope', { id: 'a', admin: true }).expect(404);
    await get(target, '/ops/telescope').expect(401);
    await get(target, '/ops/telescope', { id: 'u', admin: false }).expect(403);
    await get(target, '/ops/telescope/assets/app.js', { id: 'u', admin: false }).expect(403);
    const page = await get(target, '/ops/telescope', { id: 'a', admin: true }).expect(200);
    // The page's asset base follows `path`, i.e. where the developer mounted it.
    expect(page.text).toContain('window.__TELESCOPE_BASE__ = "/ops/telescope"');
    await get(target, '/ops/telescope/assets/app.js', { id: 'a', admin: true }).expect(200);
  });
});

describe('TelescopeUiModule production rule', () => {
  const previous = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = previous;
  });

  it('fails the boot when the page mounts with no decorators (an empty array counts as none)', () => {
    process.env.NODE_ENV = 'production';
    for (const register of [
      () => TelescopeUiModule.forRoot({ assetsDir: dir }),
      () => TelescopeUiModule.forRoot({ assetsDir: dir, decorators: [] }),
      () => TelescopeUiModule.forRootAsync({ useFactory: () => ({ assetsDir: dir }) }),
    ]) {
      expect(register).toThrow(
        /TelescopeUiModule: refusing to mount unprotected routes with NODE_ENV=production/,
      );
    }
    expect(() => TelescopeUiModule.forRoot({ assetsDir: dir })).toThrow(
      /TelescopeUiModule\.forRoot\(\{ routes: false \}\).*extends TelescopeUiController/,
    );
  });

  it('boots with decorators, and with routes: false', async () => {
    process.env.NODE_ENV = 'production';
    const decorated = await boot([
      AuthorizationModule.forRoot(),
      TelescopeUiModule.forRoot({ assetsDir: dir, decorators: [Can(ConsolePolicy, 'view')] }),
    ]);
    await get(decorated, '/telescope').expect(401);
    await get(decorated, '/telescope', { id: 'a', admin: true }).expect(200);
    await decorated.close();
    app = undefined;

    const selfMounted = await boot([TelescopeUiModule.forRoot({ assetsDir: dir, routes: false })]);
    await get(selfMounted, '/telescope').expect(404);
  });
});
