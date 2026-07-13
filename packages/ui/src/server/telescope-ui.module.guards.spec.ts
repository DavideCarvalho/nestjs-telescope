import 'reflect-metadata';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TelescopeUiModule } from './telescope-ui.module.js';

/** `telescope-ui.module.ts` inlines this instead of deep-importing '@nestjs/common/constants'. */
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

describe('TelescopeUiModule.forRoot guards', () => {
  let app: INestApplication;
  const dir = mkdtempSync(join(tmpdir(), 'tele-ui-guards-'));

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
  });

  it('rejects an anonymous page request when a stub guard denies', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeUiModule.forRoot({ assetsDir: dir, guards: [DenyGuard] })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope').expect(403);
  });

  it('also rejects an anonymous asset request when a stub guard denies', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeUiModule.forRoot({ assetsDir: dir, guards: [DenyGuard] })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope/assets/app.js').expect(403);
  });

  it('serves the page when no guards are configured (default: public shell)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeUiModule.forRoot({ assetsDir: dir })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope').expect(200);
  });

  it('a guard WITH a dependency resolves via `imports` and its dependency answers the request', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeUiModule.forRoot({
          assetsDir: dir,
          guards: [GuardWithDeps],
          imports: [HostAuthModule],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope').expect(200);
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
      imports: [TelescopeUiModule.forRoot({ assetsDir: dir, guards: [instanceGuard] })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope').expect(200);
    expect(calls).toBe(1);
  });
});

describe('TelescopeUiModule.forRootAsync guards', () => {
  let app: INestApplication;
  const dir = mkdtempSync(join(tmpdir(), 'tele-ui-guards-async-'));

  beforeAll(() => {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body></body></html>');
  });

  afterEach(async () => {
    await app?.close();
  });

  it('stamps guards passed statically on the config object (not via the async factory)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeUiModule.forRootAsync({
          useFactory: () => ({ assetsDir: dir }),
          guards: [DenyGuard],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope').expect(403);
  });

  it('resolves a guard dependency via the async config `imports`', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeUiModule.forRootAsync({
          useFactory: () => ({ assetsDir: dir }),
          guards: [GuardWithDeps],
          imports: [HostAuthModule],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/telescope').expect(200);
  });
});

// Regression guard: a class guard's dependencies must resolve from THIS module
// (TelescopeUiModule), which hosts TelescopeUiController directly.
describe('guard DI resolution across a real Nest boot', () => {
  it('throws no "cannot resolve dependencies" error when a guard with deps is used from a root app module', async () => {
    const { NestFactory } = await import('@nestjs/core');
    const dir = mkdtempSync(join(tmpdir(), 'tele-ui-guards-boot-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body></body></html>');

    @Module({
      imports: [
        HostAuthModule,
        TelescopeUiModule.forRoot({
          assetsDir: dir,
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
