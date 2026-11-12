// E2E against the REAL `@nestjs/authorization` (deny-by-default global guard).
import 'reflect-metadata';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UseConsoleAuthorize } from '@dudousxd/nestjs-telescope';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import {
  Controller,
  type DynamicModule,
  type ExecutionContext,
  type INestApplication,
  Logger,
  type Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  app = moduleRef.createNestApplication({ logger: false });
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

describe('TelescopeUiModule authorize', () => {
  const previous = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = previous;
    vi.restoreAllMocks();
  });

  const isAdmin = (ctx: ExecutionContext) =>
    (ctx.switchToHttp().getRequest() as { user?: User }).user?.admin === true;

  it('omitted: boots in production, denies the page and assets, and warns once', async () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const register of [
      () => TelescopeUiModule.forRoot({ assetsDir: dir }),
      () => TelescopeUiModule.forRoot({ assetsDir: dir, decorators: [] }),
      () => TelescopeUiModule.forRootAsync({ useFactory: () => ({ assetsDir: dir }) }),
    ]) {
      expect(register).not.toThrow();
    }
    const target = await boot([TelescopeUiModule.forRoot({ assetsDir: dir })]);
    const page = await get(target, '/telescope').set('Accept', 'text/html').expect(403);
    expect(page.text).toContain('Access denied');
    await get(target, '/telescope/assets/app.js').expect(403, { error: 'forbidden' });
    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('console has no `authorize` configured'),
    );
    expect(warnings.map(([message]) => message)).toEqual([
      '[@dudousxd/nestjs-telescope-ui] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in TelescopeUiModule.forRoot().',
    ]);
  });

  it('omitted: open outside production', async () => {
    process.env.NODE_ENV = 'development';
    const target = await boot([TelescopeUiModule.forRoot({ assetsDir: dir })]);
    await get(target, '/telescope').expect(200);
  });

  it('allows, renders the access-denied page, and redirects page navigations', async () => {
    process.env.NODE_ENV = 'production';
    const target = await boot([
      TelescopeUiModule.forRoot({
        assetsDir: dir,
        authorize: (ctx) =>
          isAdmin(ctx)
            ? true
            : (ctx.switchToHttp().getRequest() as { user?: User }).user
              ? false
              : { redirectTo: '/login' },
      }),
    ]);
    await get(target, '/telescope', { id: 'a', admin: true }).expect(200);
    await get(target, '/telescope', { id: 'u', admin: false })
      .set('Accept', 'text/html')
      .expect(403);
    await get(target, '/telescope')
      .set('Accept', 'text/html')
      .expect(302)
      .expect('Location', '/login');
    await get(target, '/telescope/assets/app.js').expect(401, {
      error: 'unauthenticated',
      redirectTo: '/login',
    });
  });

  it('an unauthenticated page navigation gets a 401 "Sign in required" page', async () => {
    process.env.NODE_ENV = 'production';
    const target = await boot([
      TelescopeUiModule.forRoot({
        assetsDir: dir,
        authorize: () => ({ allowed: false as const, reason: 'unauthenticated' as const }),
      }),
    ]);
    const page = await get(target, '/telescope').set('Accept', 'text/html').expect(401);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.text).toContain('Sign in required');
    await get(target, '/telescope/assets/app.js').expect(401, { error: 'unauthenticated' });
  });

  it('a subclass mounted with routes: false keeps the page answers', async () => {
    process.env.NODE_ENV = 'production';
    @Controller('ops/telescope')
    @UseConsoleAuthorize({ authorize: () => false })
    class OwnPage extends TelescopeUiController {}
    const target = await boot(
      [TelescopeUiModule.forRoot({ assetsDir: dir, path: 'ops/telescope', routes: false })],
      [OwnPage],
    );
    const page = await get(target, '/ops/telescope').set('Accept', 'text/html').expect(403);
    expect(page.text).toContain('Access denied');
  });

  it('forRootAsync takes authorize from the factory; decorators run first', async () => {
    process.env.NODE_ENV = 'production';
    const target = await boot([
      AuthorizationModule.forRoot(),
      TelescopeUiModule.forRootAsync({
        decorators: [Can(ConsolePolicy, 'view')],
        useFactory: () => ({ assetsDir: dir, authorize: () => true }),
      }),
    ]);
    await get(target, '/telescope').expect(401);
    await get(target, '/telescope', { id: 'a', admin: true }).expect(200);
  });

  it('routes: false boots in production and mounts nothing', async () => {
    process.env.NODE_ENV = 'production';
    const selfMounted = await boot([TelescopeUiModule.forRoot({ assetsDir: dir, routes: false })]);
    await get(selfMounted, '/telescope').expect(404);
  });
});
