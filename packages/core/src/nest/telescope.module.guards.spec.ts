// packages/core/src/nest/telescope.module.guards.spec.ts
import 'reflect-metadata';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Inject,
  Injectable,
  Module,
} from '@nestjs/common';
import { GUARDS_METADATA as REAL_GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeModule } from './telescope.module.js';

/** `telescope.module.ts` inlines this instead of deep-importing '@nestjs/common/constants'. */
const INLINED_GUARDS_METADATA = '__guards__';

describe('GUARDS_METADATA drift', () => {
  it("stays byte-identical to @nestjs/common's real GUARDS_METADATA constant", () => {
    expect(INLINED_GUARDS_METADATA).toBe(REAL_GUARDS_METADATA);
  });
});

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return false;
  }
}

@Injectable()
class AllowGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

@Injectable()
class AuthService {
  allowed(): boolean {
    return true;
  }
}

@Module({ providers: [AuthService], exports: [AuthService] })
class HostAuthModule {}

@Injectable()
class GuardWithDeps implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  canActivate(_context: ExecutionContext): boolean {
    return this.auth.allowed();
  }
}

describe('TelescopeModule.forRoot guards', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app?.close();
  });

  it('rejects an anonymous API request when a stub guard denies', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true, guards: [DenyGuard] })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope/api/meta').expect(403);
  });

  it('also gates the live SSE stream controller', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true, guards: [DenyGuard] })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope/api/stream').expect(403);
  });

  it('APPENDS to (never replaces) the built-in TelescopeGuard: the built-in gate still denies even when the host guard would allow', async () => {
    const moduleRef = await Test.createTestingModule({
      // The default (no authorizer/dashboardAuth) denies in production; force
      // that branch so we can prove the host's AllowGuard alone isn't enough.
      imports: [TelescopeModule.forRoot({ authorizer: () => false, guards: [AllowGuard] })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope/api/meta').expect(403);
  });

  it('a host guard denies even when the built-in gate would allow (AND semantics)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true, guards: [DenyGuard] })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope/api/meta').expect(403);
  });

  it('serves the API when every guard (built-in + host) allows', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true, guards: [AllowGuard] })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
  });

  it('leaves the built-in gate untouched when `guards` is omitted', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => false })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope/api/meta').expect(403);
  });

  it('a guard WITH a dependency resolves via `imports` and its dependency answers the request', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          authorizer: () => true,
          guards: [GuardWithDeps],
          imports: [HostAuthModule],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
  });

  it('accepts an already-instantiated CanActivate guard (no `imports` needed)', async () => {
    let calls = 0;
    const instanceGuard: CanActivate = {
      canActivate: () => {
        calls += 1;
        return true;
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true, guards: [instanceGuard] })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
    expect(calls).toBe(1);
  });

  it('does not gate the ungated auth/client-error/mcp controllers', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true, guards: [DenyGuard] })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    // /auth/me has its own gate semantics (404 when dashboardAuth isn't
    // configured), never the console guard's 403 — proving DenyGuard was
    // never stamped onto the auth controller.
    await request(app.getHttpServer()).get('/telescope/api/auth/me').expect(404);
  });
});

describe('TelescopeModule.forRootAsync guards', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app?.close();
  });

  it('stamps guards passed statically on the config object (not via the async factory)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRootAsync({
          useFactory: () => ({ authorizer: () => true }),
          guards: [DenyGuard],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope/api/meta').expect(403);
  });

  it('resolves a guard dependency via the async config `imports`', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRootAsync({
          useFactory: () => ({ authorizer: () => true }),
          guards: [GuardWithDeps],
          imports: [HostAuthModule],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
  });
});

// Regression guard: a class guard's dependencies must resolve from THIS module
// (TelescopeModule), which hosts the console controllers directly — unlike
// nestjs-agent's dashboard (split into a UI module + a separate API sub-module),
// Telescope registers every console controller on the ONE TelescopeModule, so
// there is no extra sub-module wiring needed for guard DI to reach a real app.
describe('guard DI resolution across a real Nest boot', () => {
  it('throws no "cannot resolve dependencies" error when a guard with deps is used from a root app module', async () => {
    const { NestFactory } = await import('@nestjs/core');

    @Module({
      imports: [
        HostAuthModule,
        TelescopeModule.forRoot({
          authorizer: () => true,
          guards: [GuardWithDeps],
          imports: [HostAuthModule],
        }),
      ],
    })
    class HostRootModule {}

    const app = await NestFactory.create(HostRootModule, { logger: false, abortOnError: false });
    await app.init();
    await app.close();
  });
});
