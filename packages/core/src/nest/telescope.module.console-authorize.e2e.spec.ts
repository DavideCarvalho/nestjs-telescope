// packages/core/src/nest/telescope.module.console-authorize.e2e.spec.ts
//
// The console's `authorize` over HTTP: every mounted console controller (API,
// SSE stream) runs it; the public client-error beacon does not.
import 'reflect-metadata';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthorizationModule, Policy } from '@nestjs/authorization';
import {
  type CanActivate,
  Controller,
  type DynamicModule,
  type ExecutionContext,
  Get,
  type INestApplication,
  Inject,
  Injectable,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsolePage, UseConsoleAuthorize } from './console-authorize.guard.js';
import { authorizeByToken } from './console-authorize.js';
import { TelescopeModule } from './telescope.module.js';

type User = { id: string; admin: boolean };

@Policy()
class ConsolePolicy {
  view(user: User | null): boolean {
    return user?.admin === true;
  }
}

const META = '/telescope/api/meta';
const STREAM = '/telescope/api/stream';
const BEACON = '/telescope/api/client-errors';

const previousEnv = process.env.NODE_ENV;
let app: INestApplication | undefined;

beforeEach(() => {
  process.env.NODE_ENV = 'test';
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env.NODE_ENV = previousEnv;
  vi.restoreAllMocks();
});

/** `x-user` (JSON) becomes `request.user`, standing in for the app's authentication. */
async function boot(
  imports: DynamicModule[],
  extra: { providers?: unknown[]; controllers?: unknown[] } = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports,
    providers: (extra.providers ?? []) as never[],
    controllers: (extra.controllers ?? []) as never[],
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

function adminHeader(admin: boolean): string {
  return JSON.stringify({ id: admin ? 'a' : 'u', admin });
}

async function streamStatus(target: INestApplication, headers: Record<string, string> = {}) {
  const server = target.getHttpServer() as http.Server;
  if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return new Promise<number>((resolve, reject) => {
    const req = http.get({ port, path: STREAM, headers }, (res) => {
      resolve(res.statusCode ?? 0);
      res.destroy();
      req.destroy();
    });
    req.on('error', reject);
  });
}

const isAdmin = (ctx: ExecutionContext) =>
  (ctx.switchToHttp().getRequest() as { user?: User }).user?.admin === true;

/** The app's authentication: sets `request.user` from `x-auth`. */
@Injectable()
class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest() as {
      headers: Record<string, string>;
      user?: User;
    };
    const who = req.headers['x-auth'];
    if (who) req.user = { id: who, admin: who === 'admin' };
    return true;
  }
}

// Listed ABOVE the auth guard: Nest applies class decorators bottom-up, so the
// auth guard runs first and `request.user` is set when `authorize` runs.
@Controller('ops/api')
@UseConsoleAuthorize()
@UseGuards(AuthGuard)
class SelfMountedApi {
  @Get()
  index() {
    return 'api';
  }
}

describe('TelescopeModule authorize', () => {
  it('allows, then 403 { error: forbidden } on API and SSE', async () => {
    const target = await boot([
      TelescopeModule.forRoot({ authorize: isAdmin, clientErrors: { enabled: true } }),
    ]);
    const server = target.getHttpServer();
    await request(server).get(META).set('x-user', adminHeader(true)).expect(200);
    const denied = await request(server).get(META).set('x-user', adminHeader(false)).expect(403);
    expect(denied.body).toEqual({ error: 'forbidden' });
    expect(await streamStatus(target)).toBe(403);
    expect(await streamStatus(target, { 'x-user': adminHeader(true) })).toBe(200);
    // The public beacon takes no authorize.
    const beacon = await request(server).post(BEACON).send({ message: 'x' });
    expect([401, 403]).not.toContain(beacon.status);
  });

  it('401 { error: unauthenticated } for reason unauthenticated', async () => {
    const target = await boot([
      TelescopeModule.forRoot({
        authorize: (_ctx) => ({ allowed: false, reason: 'unauthenticated' }),
      }),
    ]);
    await request(target.getHttpServer()).get(META).expect(401, { error: 'unauthenticated' });
  });

  it('{ redirectTo } answers API calls with 401 and the redirect target', async () => {
    const target = await boot([
      TelescopeModule.forRoot({ authorize: () => ({ redirectTo: '/login' }) }),
    ]);
    await request(target.getHttpServer())
      .get(META)
      .set('Accept', 'text/html')
      .expect(401, { error: 'unauthenticated', redirectTo: '/login' });
  });

  it('a throw denies with 403', async () => {
    const target = await boot([
      TelescopeModule.forRoot({
        authorize: () => {
          throw new Error('boom');
        },
      }),
    ]);
    await request(target.getHttpServer()).get(META).expect(403, { error: 'forbidden' });
  });

  it('the policy form runs @nestjs/authorization: guest 401, user 403, admin 200', async () => {
    const target = await boot(
      [
        AuthorizationModule.forRoot(),
        TelescopeModule.forRoot({ authorize: { policy: ConsolePolicy, ability: 'view' } }),
      ],
      { providers: [ConsolePolicy] },
    );
    const server = target.getHttpServer();
    await request(server).get(META).expect(401, { error: 'unauthenticated' });
    await request(server).get(META).set('x-user', adminHeader(false)).expect(403);
    await request(server).get(META).set('x-user', adminHeader(true)).expect(200);
  });

  it('the policy form without AuthorizationModule fails the boot', async () => {
    await expect(
      boot([TelescopeModule.forRoot({ authorize: { policy: ConsolePolicy, ability: 'view' } })]),
    ).rejects.toThrow(/needs AuthorizationModule\.forRoot\(\)/);
  });

  it('a gate name without the console-gate provider fails the boot', async () => {
    await expect(
      boot([TelescopeModule.forRoot({ authorize: 'console.telescope' })]),
    ).rejects.toThrow(/needs @dudousxd\/nestjs-authz's AuthzModule/);
  });

  it('a gate name asks the console-gate provider', async () => {
    const allows = vi.fn(async (_name: string, ctx: ExecutionContext) => isAdmin(ctx));
    const target = await boot([TelescopeModule.forRoot({ authorize: 'console.telescope' })], {
      providers: [{ provide: Symbol.for('@dudousxd/aviary:console-gate'), useValue: { allows } }],
    });
    const server = target.getHttpServer();
    await request(server).get(META).set('x-user', adminHeader(true)).expect(200);
    await request(server).get(META).expect(403);
    expect(allows).toHaveBeenCalledWith('console.telescope', expect.anything());
  });

  it('forRootAsync takes authorize from the factory', async () => {
    const target = await boot([
      TelescopeModule.forRootAsync({
        useFactory: () => ({ authorize: authorizeByToken({ token: 'from-config' }) }),
      }),
    ]);
    const server = target.getHttpServer();
    await request(server).get(META).expect(401);
    await request(server).get(META).set('Authorization', 'Bearer from-config').expect(200);
  });
});

describe('TelescopeModule without authorize', () => {
  it('is open outside production', async () => {
    const target = await boot([TelescopeModule.forRoot()]);
    const server = target.getHttpServer();
    await request(server).get(META).expect(200);
  });

  it('boots in production, answers 403 everywhere, and warns once', async () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const target = await boot([TelescopeModule.forRoot({ clientErrors: { enabled: true } })]);
    const server = target.getHttpServer();
    await request(server).get(META).expect(403, { error: 'forbidden' });
    expect(await streamStatus(target)).toBe(403);
    const beacon = await request(server).post(BEACON).send({ message: 'x' });
    expect(beacon.status).not.toBe(403);
    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('console has no `authorize` configured'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toBe(
      '[@dudousxd/nestjs-telescope] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in TelescopeModule.forRoot().',
    );
  });

  it('decorators alone do not count as authorize', async () => {
    process.env.NODE_ENV = 'production';
    const noop: ClassDecorator = () => undefined;
    const target = await boot([TelescopeModule.forRoot({ decorators: [noop] })]);
    await request(target.getHttpServer()).get(META).expect(403);
  });

  it('names forRootAsync() in the warning when that registration is used', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await boot([TelescopeModule.forRootAsync({ useFactory: () => ({}) })]);
    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('console has no `authorize` configured'),
    );
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain(
      'Set `authorize` in TelescopeModule.forRootAsync().',
    );
  });

  it('routes: false boots in production, mounts nothing, and still warns once', async () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const target = await boot([TelescopeModule.forRoot({ routes: false })], {
      controllers: [SelfMountedApi],
    });
    await request(target.getHttpServer()).get(META).expect(404);
    // The exported guard still applies the production 403.
    await request(target.getHttpServer()).get('/ops/api').expect(403, { error: 'forbidden' });
    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('console has no `authorize` configured'),
    );
    expect(warnings).toHaveLength(1);
  });
});

@Injectable()
class AuditLog {
  readonly seen: string[] = [];
}

@Injectable()
class ConsoleAccess {
  constructor(@Inject(AuditLog) private readonly audit: AuditLog) {}
  authorize(ctx: ExecutionContext) {
    this.audit.seen.push('checked');
    return isAdmin(ctx) ? true : { redirectTo: '/login' };
  }
}

describe('UseConsoleAuthorize on a self-mounted controller', () => {
  @Controller('ops/page')
  @ConsolePage()
  @UseConsoleAuthorize({ authorize: ConsoleAccess })
  class Page {
    @Get()
    index() {
      return 'page';
    }
  }

  @Controller('ops/forbidden')
  @ConsolePage()
  @UseConsoleAuthorize({ authorize: () => false })
  class ForbiddenPage {
    @Get()
    index() {
      return 'page';
    }
  }

  @Controller('ops/sign-in')
  @ConsolePage()
  @UseConsoleAuthorize({
    authorize: () => ({ allowed: false as const, reason: 'unauthenticated' as const }),
  })
  class SignInPage {
    @Get()
    index() {
      return 'page';
    }
  }

  it('injects the class form, redirects page navigations and 401s API calls', async () => {
    const target = await boot([TelescopeModule.forRoot({ routes: false, authorize: isAdmin })], {
      providers: [AuditLog],
      controllers: [Page, ForbiddenPage],
    });
    const server = target.getHttpServer();
    await request(server).get('/ops/page').set('x-user', adminHeader(true)).expect(200);
    await request(server)
      .get('/ops/page')
      .set('Accept', 'text/html,application/xhtml+xml')
      .expect(302)
      .expect('Location', '/login');
    await request(server)
      .get('/ops/page')
      .set('Accept', 'application/json')
      .expect(401, { error: 'unauthenticated', redirectTo: '/login' });
    expect(target.get(AuditLog).seen).toHaveLength(3);

    const html = await request(server).get('/ops/forbidden').set('Accept', 'text/html').expect(403);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.text).toContain('Access denied');
    await request(server).get('/ops/forbidden').expect(403, { error: 'forbidden' });
  });

  it('an unauthenticated page navigation gets a 401 "Sign in required" page; API calls JSON', async () => {
    const target = await boot([TelescopeModule.forRoot({ routes: false, authorize: isAdmin })], {
      controllers: [SignInPage],
    });
    const server = target.getHttpServer();
    const html = await request(server).get('/ops/sign-in').set('Accept', 'text/html').expect(401);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.text).toContain('Sign in required');
    await request(server)
      .get('/ops/sign-in')
      .set('Accept', 'application/json')
      .expect(401, { error: 'unauthenticated' });
  });

  it("@UseConsoleAuthorize() above the app's auth guard runs TelescopeModule's authorize after it", async () => {
    const target = await boot([TelescopeModule.forRoot({ routes: false, authorize: isAdmin })], {
      controllers: [SelfMountedApi],
    });
    const server = target.getHttpServer();
    // The auth guard reads `x-auth`, not the middleware's `x-user`: only it sets `request.user`.
    await request(server).get('/ops/api').set('x-auth', 'admin').expect(200, 'api');
    await request(server).get('/ops/api').set('x-auth', 'user').expect(403, { error: 'forbidden' });
    await request(server).get('/ops/api').expect(403, { error: 'forbidden' });
  });
});
