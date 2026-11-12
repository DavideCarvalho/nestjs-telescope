// packages/core/src/nest/telescope.module.production.spec.ts
//
// Production: the console boots without `authorize` and answers 403; a `Can()`
// in `decorators` still runs first; `routes: false` mounts nothing.
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

describe('TelescopeModule in production', () => {
  it('no longer refuses to boot without decorators: it mounts and answers 403', async () => {
    expect(() => TelescopeModule.forRoot({})).not.toThrow();
    expect(() => TelescopeModule.forRoot({ decorators: [] })).not.toThrow();
    expect(() => TelescopeModule.forRootAsync({ useFactory: () => ({}) })).not.toThrow();
    const target = await boot(TelescopeModule.forRoot({}));
    await request(target.getHttpServer())
      .get('/telescope/api/meta')
      .expect(403, { error: 'forbidden' });
  });

  it('answers once authorize allows', async () => {
    const target = await boot(TelescopeModule.forRoot({ authorize: () => true }));
    await request(target.getHttpServer()).get('/telescope/api/meta').expect(200);
  });

  it('decorators still run before authorize', async () => {
    const target = await boot(
      TelescopeModule.forRoot({ decorators: [Can(ConsolePolicy, 'view')], authorize: () => true }),
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
        authorize: () => true,
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
