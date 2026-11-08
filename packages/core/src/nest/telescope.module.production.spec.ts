// packages/core/src/nest/telescope.module.production.spec.ts
//
// The production rule: with NODE_ENV=production, mounting the console with no
// `decorators` fails the boot; `decorators` or `routes: false` boot fine.
import 'reflect-metadata';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import type { DynamicModule, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelescopeModule } from './telescope.module.js';

@Policy()
class ConsolePolicy {
  view(user: { admin?: boolean } | null): boolean {
    return user?.admin === true;
  }
}

const previous = process.env.NODE_ENV;
let app: INestApplication | undefined;

beforeEach(() => {
  process.env.NODE_ENV = 'production';
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env.NODE_ENV = previous;
});

async function boot(telescope: DynamicModule): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AuthorizationModule.forRoot(), telescope],
    providers: [ConsolePolicy],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('TelescopeModule production rule', () => {
  it('fails the boot when the console mounts with no decorators', () => {
    expect(() => TelescopeModule.forRoot({})).toThrow(
      /refusing to mount undecorated routes with NODE_ENV=production/,
    );
  });

  it('counts an empty decorators array as none, on forRoot and forRootAsync', () => {
    expect(() => TelescopeModule.forRoot({ decorators: [] })).toThrow(/NODE_ENV=production/);
    expect(() => TelescopeModule.forRootAsync({ useFactory: () => ({}) })).toThrow(
      /NODE_ENV=production/,
    );
  });

  it('names both ways to protect it, with an example of each', () => {
    let message = '';
    try {
      TelescopeModule.forRoot({ path: 'ops/telescope' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      "TelescopeModule.forRoot({ decorators: [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')] })",
    );
    expect(message).toContain('TelescopeModule.forRoot({ routes: false })');
    expect(message).toContain(
      "@Controller('ops/telescope/api') @Can(ConsolePolicy, 'view') class ConsoleApi extends TelescopeController {}",
    );
  });

  it('boots with decorators, and they protect the console', async () => {
    const target = await boot(
      TelescopeModule.forRoot({ decorators: [Can(ConsolePolicy, 'view')] }),
    );
    await request(target.getHttpServer()).get('/telescope/api/meta').expect(401);
  });

  it('boots with routes: false and no decorators (the host mounts and protects the routes)', async () => {
    const target = await boot(TelescopeModule.forRoot({ routes: false }));
    await request(target.getHttpServer()).get('/telescope/api/meta').expect(404);
  });

  it('keeps the public client-error beacon reachable by guests', async () => {
    const target = await boot(
      TelescopeModule.forRoot({
        decorators: [Can(ConsolePolicy, 'view')],
        clientErrors: { enabled: true },
      }),
    );
    await request(target.getHttpServer())
      .post('/telescope/api/client-errors')
      .send({ message: 'boom' })
      .expect(204);
  });

  it('outside production an undecorated console mounts open', async () => {
    process.env.NODE_ENV = 'development';
    const target = await boot(TelescopeModule.forRoot({}));
    await request(target.getHttpServer()).get('/telescope/api/meta').expect(200);
  });
});
