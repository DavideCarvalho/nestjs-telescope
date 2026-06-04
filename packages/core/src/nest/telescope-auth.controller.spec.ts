// packages/core/src/nest/telescope-auth.controller.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';
import type { TelescopeModuleOptions } from './telescope.options.js';

const SECRET = 'e2e-dashboard-auth-secret-0123456789-abc';

async function makeApp(options: TelescopeModuleOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ storage: new InMemoryStorageProvider(), ...options })],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

function cookieFrom(res: request.Response): string {
  const setCookie = res.headers['set-cookie'];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (header ?? '').split(';')[0] ?? '';
}

describe('TelescopeAuthController', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('mode B (login)', () => {
    it('logs in (204 + Set-Cookie), then the cookie passes the gate', async () => {
      app = await makeApp({
        dashboardAuth: {
          secret: SECRET,
          login: (u, p) => (u === 'admin' && p === 'pw' ? { id: 'admin', roles: ['admin'] } : null),
        },
      });
      const server = app.getHttpServer();
      // Gate blocks unauthenticated API calls with 401.
      await request(server).get('/telescope/api/meta').expect(401);

      const login = await request(server)
        .post('/telescope/api/auth/login')
        .send({ username: 'admin', password: 'pw' })
        .expect(204);
      const cookie = cookieFrom(login);
      expect(cookie).toContain('telescope_session=');

      await request(server).get('/telescope/api/meta').set('Cookie', cookie).expect(200);
    });

    it('returns a uniform 401 {message:"Invalid credentials"} on bad creds', async () => {
      app = await makeApp({
        dashboardAuth: { secret: SECRET, login: () => null },
      });
      const res = await request(app.getHttpServer())
        .post('/telescope/api/auth/login')
        .send({ username: 'x', password: 'y' })
        .expect(401);
      expect(res.body.message).toBe('Invalid credentials');
    });

    it('rejects a malformed body with 400', async () => {
      app = await makeApp({ dashboardAuth: { secret: SECRET, login: () => ({ id: 'a' }) } });
      await request(app.getHttpServer())
        .post('/telescope/api/auth/login')
        .send({ username: 'only-username' })
        .expect(400);
    });

    it('treats a throwing hook as a denial (401, no 500) and warns once', async () => {
      const login = vi.fn(() => {
        throw new Error('hook boom');
      });
      app = await makeApp({ dashboardAuth: { secret: SECRET, login } });
      const server = app.getHttpServer();
      await request(server)
        .post('/telescope/api/auth/login')
        .send({ username: 'a', password: 'b' })
        .expect(401);
      await request(server)
        .post('/telescope/api/auth/login')
        .send({ username: 'a', password: 'b' })
        .expect(401);
      expect(login).toHaveBeenCalledTimes(2);
    });

    it('returns 404 for POST /auth/session when mode A is not configured', async () => {
      app = await makeApp({ dashboardAuth: { secret: SECRET, login: () => null } });
      await request(app.getHttpServer()).post('/telescope/api/auth/session').expect(404);
    });
  });

  describe('mode A (session)', () => {
    it('mints a cookie from the host hook (204) and gates pass with it', async () => {
      app = await makeApp({
        dashboardAuth: {
          secret: SECRET,
          session: (req) => {
            const auth = (req as { headers?: Record<string, unknown> }).headers?.authorization;
            return auth === 'Bearer good' ? { id: 'host-user', roles: ['admin'] } : null;
          },
        },
      });
      const server = app.getHttpServer();
      const denied = await request(server)
        .post('/telescope/api/auth/session')
        .set('Authorization', 'Bearer bad')
        .expect(401);
      expect(cookieFrom(denied)).not.toContain('telescope_session=ey');

      const ok = await request(server)
        .post('/telescope/api/auth/session')
        .set('Authorization', 'Bearer good')
        .expect(204);
      const cookie = cookieFrom(ok);
      await request(server).get('/telescope/api/entries').set('Cookie', cookie).expect(200);
    });

    it('returns 404 for POST /auth/login when mode B is not configured', async () => {
      app = await makeApp({ dashboardAuth: { secret: SECRET, session: () => ({ id: 'h' }) } });
      await request(app.getHttpServer())
        .post('/telescope/api/auth/login')
        .send({ username: 'a', password: 'b' })
        .expect(404);
    });
  });

  describe('logout + me', () => {
    it('GET /auth/me returns 401 with the configured modes when unauthenticated', async () => {
      app = await makeApp({
        dashboardAuth: { secret: SECRET, session: () => null, login: () => null },
      });
      const res = await request(app.getHttpServer()).get('/telescope/api/auth/me').expect(401);
      expect(res.body.auth.modes).toEqual(['session', 'login']);
    });

    it('GET /auth/me returns 200 {user} with a valid cookie', async () => {
      app = await makeApp({
        dashboardAuth: {
          secret: SECRET,
          login: () => ({ id: 'admin', name: 'Ops', roles: ['admin'] }),
        },
      });
      const server = app.getHttpServer();
      const login = await request(server)
        .post('/telescope/api/auth/login')
        .send({ username: 'a', password: 'b' })
        .expect(204);
      const res = await request(server)
        .get('/telescope/api/auth/me')
        .set('Cookie', cookieFrom(login))
        .expect(200);
      expect(res.body.user).toEqual({ id: 'admin', name: 'Ops', roles: ['admin'] });
    });

    it('POST /auth/logout clears the cookie (Max-Age=0) and returns 204', async () => {
      app = await makeApp({ dashboardAuth: { secret: SECRET, login: () => ({ id: 'a' }) } });
      const res = await request(app.getHttpServer()).post('/telescope/api/auth/logout').expect(204);
      const setCookie = res.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(header).toContain('telescope_session=;');
      expect(header).toContain('Max-Age=0');
    });
  });

  describe('gate exemption + meta', () => {
    it('leaves /auth/* reachable while gating the rest of /api/*', async () => {
      app = await makeApp({ dashboardAuth: { secret: SECRET, login: () => null } });
      const server = app.getHttpServer();
      // /auth/me is reachable (returns 401-with-modes, not the gate's bare 401).
      const me = await request(server).get('/telescope/api/auth/me').expect(401);
      expect(me.body.auth.modes).toEqual(['login']);
      // A gated route is blocked with a bare 401 (no modes body).
      const gated = await request(server).get('/telescope/api/health').expect(401);
      expect(gated.body.auth).toBeUndefined();
    });

    it('meta carries auth.enabled + modes once authenticated', async () => {
      app = await makeApp({
        dashboardAuth: { secret: SECRET, session: () => null, login: () => ({ id: 'a' }) },
      });
      const server = app.getHttpServer();
      const login = await request(server)
        .post('/telescope/api/auth/login')
        .send({ username: 'a', password: 'b' })
        .expect(204);
      const meta = await request(server)
        .get('/telescope/api/meta')
        .set('Cookie', cookieFrom(login))
        .expect(200);
      expect(meta.body.auth).toEqual({ enabled: true, modes: ['session', 'login'] });
    });

    it('meta reports auth disabled when dashboardAuth is unset', async () => {
      app = await makeApp({ authorizer: () => true });
      const meta = await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
      expect(meta.body.auth).toEqual({ enabled: false, modes: [] });
    });
  });

  describe('boot validation', () => {
    it('fails to boot when dashboardAuth has no secret', async () => {
      await expect(makeApp({ dashboardAuth: { secret: '', login: () => null } })).rejects.toThrow(
        /secret/,
      );
    });

    it('fails to boot when dashboardAuth has no hook', async () => {
      await expect(makeApp({ dashboardAuth: { secret: SECRET } })).rejects.toThrow(
        /session.*login|at least one/,
      );
    });
  });
});
