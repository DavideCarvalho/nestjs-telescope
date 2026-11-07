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
import { TelescopeAuthController } from './telescope-auth.controller.js';
import { TelescopeMcpController } from './telescope-mcp.controller.js';
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

@Can(ConsolePolicy, 'view')
@Controller('ops/telescope/api/mcp')
class ConsoleMcp extends TelescopeMcpController {}

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
    authorizer: () => true,
  } satisfies TelescopeModuleOptions),
  controllers: Type[] = [ConsoleApi, ConsoleStream, ConsoleMcp, HelloController],
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

    const target = await boot(TelescopeModule.forRoot({ routes: false, authorizer: () => true }), [
      HelloController,
    ]);
    expect(target.get(TelescopeService)).toBeInstanceOf(TelescopeService);
    expect((await get(target, '/telescope/api/meta', ADMIN)).status).toBe(404);
    expect((await get(target, '/telescope/api/auth/me', ADMIN)).status).toBe(404);
  });

  it('developer-mounted routes protected with @Can: guest 401, denied 403, allowed 200', async () => {
    const target = await boot();
    for (const url of ['/ops/telescope/api/meta', '/ops/telescope/api/entries']) {
      expect((await get(target, url, GUEST)).status, `guest ${url}`).toBe(401);
      expect((await get(target, url, USER)).status, `user ${url}`).toBe(403);
      expect((await get(target, url, ADMIN)).status, `admin ${url}`).toBe(200);
    }
    // The MCP subclass too (its own token/dev check runs after @Can lets it through).
    const mcp = (user?: User) => {
      const req = request(target.getHttpServer())
        .post('/ops/telescope/api/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      if (user) req.set('x-user', JSON.stringify(user));
      return req;
    };
    expect((await mcp()).status).toBe(401);
    expect((await mcp(USER)).status).toBe(403);
    expect([401, 403]).not.toContain((await mcp(ADMIN)).status);
    // Nothing is left at the library's own mount.
    expect((await get(target, '/ops/telescope/api/auth/me', ADMIN)).status).toBe(404);
  });

  it('capture keeps working and the self-mounted API serves it (own path self-skipped)', async () => {
    const target = await boot();
    await get(target, '/hello').expect(200);
    await get(target, '/ops/telescope/api/meta', ADMIN).expect(200);
    await target.get(TelescopeService).flush();

    const res = await get(target, '/ops/telescope/api/entries?type=request', ADMIN).expect(200);
    const urls = res.body.data.map((e: { content: { uri?: string; url?: string } }) =>
      String(e.content.uri ?? e.content.url),
    );
    expect(urls.some((u: string) => u.includes('/hello'))).toBe(true);
    // `path: 'ops/telescope'` keeps the capture from recording the console's own calls.
    expect(urls.some((u: string) => u.includes('/ops/telescope'))).toBe(false);
  });

  it("inherited routes keep Telescope's own gate: authorizer false stays 403 even when @Can allows", async () => {
    const target = await boot(
      TelescopeModule.forRoot({ path: 'ops/telescope', routes: false, authorizer: () => false }),
    );
    expect((await get(target, '/ops/telescope/api/meta', ADMIN)).status).toBe(403);
  });

  it('forRootAsync takes routes as a static top-level option', async () => {
    const mod = TelescopeModule.forRootAsync({
      useFactory: () => ({ authorizer: () => true }),
      routes: false,
    });
    expect(mod.controllers).toEqual([]);

    const target = await boot(
      TelescopeModule.forRootAsync({
        useFactory: () => ({ authorizer: () => true }),
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
    for (const base of [
      TelescopeController,
      StreamController,
      TelescopeAuthController,
      ClientErrorController,
      TelescopeMcpController,
    ]) {
      expect(Reflect.getOwnMetadata('optional:paramtypes', base), base.name).toBeUndefined();
    }
  });
});
