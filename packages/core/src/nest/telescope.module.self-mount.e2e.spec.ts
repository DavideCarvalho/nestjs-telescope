// packages/core/src/nest/telescope.module.self-mount.e2e.spec.ts
//
// `routes: false` + "mount it yourself": TelescopeModule mounts nothing, the
// host serves the routes from its OWN controllers (subclasses of the exported
// ones) and protects them with the real `@nestjs/authorization` — the same
// shape as `@nestjs/mcp`'s `path: false`.
import 'reflect-metadata';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import { Controller, Get, type INestApplication, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { StreamController } from '../sse/stream.controller.js';
import { ClientErrorController } from './client-error.controller.js';
import { TelescopeController } from './telescope.controller.js';
import { TelescopeModule } from './telescope.module.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

type User = { id: string; admin: boolean };

@Policy()
class ConsolePolicy {
  view(user: User | null): boolean {
    return user?.admin === true;
  }
}

// The developer's own controllers: same routes, their own mount and decorators.
@Can(ConsolePolicy, 'view')
@Controller('ops/telescope/api')
class ConsoleApi extends TelescopeController {}

@Can(ConsolePolicy, 'view')
@Controller('ops/telescope/api')
class ConsoleStream extends StreamController {}

@Can.Anyone()
@Controller('hello')
class HelloController {
  @Get()
  hello(): string {
    return 'hi';
  }
}

const GUEST = undefined;
const USER: User = { id: 'u', admin: false };
const ADMIN: User = { id: 'a', admin: true };

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(
  telescope = TelescopeModule.forRoot({
    path: 'ops/telescope',
    routes: false,
  } satisfies TelescopeModuleOptions),
  controllers: Type[] = [ConsoleApi, ConsoleStream, HelloController],
) {
  const moduleRef = await Test.createTestingModule({
    imports: [AuthorizationModule.forRoot(), telescope],
    controllers,
    providers: [ConsolePolicy],
  }).compile();
  app = moduleRef.createNestApplication();
  // Stands in for the host's authentication: `x-user` (JSON) becomes `request.user`.
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
  if (user) req.set('x-user', JSON.stringify(user));
  return req;
}

describe('TelescopeModule routes: false (mount it yourself)', () => {
  it('mounts no controller, while every provider still resolves', async () => {
    const mod = TelescopeModule.forRoot({
      routes: false,
      decorators: [Can(ConsolePolicy, 'view')],
    });
    expect(mod.controllers).toEqual([]);

    const target = await boot(TelescopeModule.forRoot({ routes: false }), [HelloController]);
    expect(target.get(TelescopeService)).toBeInstanceOf(TelescopeService);
    expect((await get(target, '/telescope/api/meta', ADMIN)).status).toBe(404);
  });

  it('developer-mounted routes protected with @Can: guest 401, denied 403, allowed 200', async () => {
    const target = await boot();
    for (const url of ['/ops/telescope/api/meta', '/ops/telescope/api/entries']) {
      expect((await get(target, url, GUEST)).status, `guest ${url}`).toBe(401);
      expect((await get(target, url, USER)).status, `user ${url}`).toBe(403);
      expect((await get(target, url, ADMIN)).status, `admin ${url}`).toBe(200);
    }
  });

  it('capture keeps working and the self-mounted API serves it (own path self-skipped)', async () => {
    const target = await boot();
    await get(target, '/hello').expect(200);
    await get(target, '/ops/telescope/api/meta', ADMIN).expect(200);
    await target.get(TelescopeService).flush();

    const res = await get(target, '/ops/telescope/api/entries?filter[type]=request', ADMIN).expect(
      200,
    );
    const urls = res.body.data.map((e: { content: { uri?: string; url?: string } }) =>
      String(e.content.uri ?? e.content.url),
    );
    expect(urls.some((u: string) => u.includes('/hello'))).toBe(true);
    // `path: 'ops/telescope'` keeps the capture from recording the console's own calls.
    expect(urls.some((u: string) => u.includes('/ops/telescope'))).toBe(false);
  });

  it('inherited routes carry no built-in guard: the developer decorators are the whole gate, even in production', async () => {
    // No guard metadata on any extendable base class, so a subclass inherits none.
    for (const base of [TelescopeController, StreamController, ClientErrorController]) {
      expect(Reflect.getMetadata('__guards__', base), base.name).toBeUndefined();
    }
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      // `routes: false` boots in production with no `decorators` …
      const target = await boot();
      // … and the developer's @Can alone decides: no built-in prod-closed gate.
      expect((await get(target, '/ops/telescope/api/meta', USER)).status).toBe(403);
      expect((await get(target, '/ops/telescope/api/meta', ADMIN)).status).toBe(200);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('forRootAsync takes routes as a static top-level option', async () => {
    const mod = TelescopeModule.forRootAsync({
      useFactory: () => ({}),
      routes: false,
    });
    expect(mod.controllers).toEqual([]);

    const target = await boot(
      TelescopeModule.forRootAsync({
        useFactory: () => ({}),
        path: 'ops/telescope',
        routes: false,
      }),
    );
    expect((await get(target, '/ops/telescope/api/meta', USER)).status).toBe(403);
    expect((await get(target, '/ops/telescope/api/meta', ADMIN)).status).toBe(200);
  });

  it('the exported controllers carry no own-only constructor metadata a subclass would lose', () => {
    // Nest reads `@Optional()` constructor params with getOwnMetadata, so a
    // subclass silently drops them. None of the extendable controllers use it.
    for (const base of [TelescopeController, StreamController, ClientErrorController]) {
      expect(Reflect.getOwnMetadata('optional:paramtypes', base), base.name).toBeUndefined();
    }
  });
});
