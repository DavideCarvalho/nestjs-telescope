// packages/core/src/nest/telescope-auth.fastify.spec.ts
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';

const SECRET = 'fastify-auth-secret-key-0123456789-abcd';

function sessionCookie(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (header ?? '').split(';')[0] ?? '';
}

describe('dashboardAuth (e2e, Fastify)', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('login => cookie => API allowed => logout => 401', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          storage: new InMemoryStorageProvider(),
          dashboardAuth: {
            secret: SECRET,
            login: (u, p) =>
              u === 'admin' && p === 'pw' ? { id: 'admin', roles: ['admin'] } : null,
          },
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // Gate blocks unauthenticated.
    const blocked = await app.inject({ method: 'GET', url: '/telescope/api/entries' });
    expect(blocked.statusCode).toBe(401);

    // Login mints the cookie.
    const login = await app.inject({
      method: 'POST',
      url: '/telescope/api/auth/login',
      payload: { username: 'admin', password: 'pw' },
    });
    expect(login.statusCode).toBe(204);
    const cookie = sessionCookie(login.headers['set-cookie']);
    expect(cookie).toContain('telescope_session=');

    // Cookie passes the gate.
    const allowed = await app.inject({
      method: 'GET',
      url: '/telescope/api/entries',
      headers: { cookie },
    });
    expect(allowed.statusCode).toBe(200);

    // Logout clears it.
    const logout = await app.inject({
      method: 'POST',
      url: '/telescope/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);
    const cleared = sessionCookie(logout.headers['set-cookie']);
    expect(logout.headers['set-cookie']).toBeDefined();
    expect(cleared).toContain('telescope_session=');

    // A fresh request without the cookie is blocked again.
    const after = await app.inject({ method: 'GET', url: '/telescope/api/entries' });
    expect(after.statusCode).toBe(401);
  });
});
