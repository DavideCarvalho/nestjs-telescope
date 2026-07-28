import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE_NAME, signSessionCookie } from '@dudousxd/nestjs-telescope';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TelescopeUiModule } from './telescope-ui.module.js';

const SECRET = 's'.repeat(32);
/** Distinctive marker in the fake bundle so "did the SPA get served?" is unambiguous. */
const SPA_MARKER = 'telescope-spa-shell';

/** Express `Response` surface the hooks use; the spec never imports Express itself. */
interface HostResponse {
  status(code: number): HostResponse;
  type(value: string): HostResponse;
  send(body: string): unknown;
}

/**
 * Telescope's auth screen is a React component inside the published bundle, so — unlike durable and
 * agent — there is no server-rendered page for a host to replace. `unauthenticatedPage` therefore
 * gates the SPA SHELL route, which this module (not core) owns: an unauthenticated navigation gets
 * the host's page instead of the bundle, and the bundle stops loading at all for someone with no
 * session.
 */
describe('TelescopeUiModule — dashboardAuth.unauthenticatedPage', () => {
  let app: INestApplication | undefined;
  const dir = mkdtempSync(join(tmpdir(), 'tele-ui-unauth-'));

  beforeAll(() => {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(
      join(dir, 'index.html'),
      `<!doctype html><html><head></head><body><div id="${SPA_MARKER}"></div></body></html>`,
    );
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(options: Parameters<typeof TelescopeUiModule.forRoot>[0]) {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeUiModule.forRoot({ assetsDir: dir, ...options })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app.getHttpServer();
  }

  it('serves the host page at the dashboard URL instead of the SPA shell', async () => {
    const server = await boot({
      dashboardAuth: {
        secret: SECRET,
        session: () => null,
        unauthenticatedPage: ({ response }) => {
          (response as HostResponse)
            .status(401)
            .type('html')
            .send('<html><body>Open Telescope from the control panel</body></html>');
        },
      },
    });

    const page = await request(server).get('/telescope').expect(401);
    expect(page.text).toContain('Open Telescope from the control panel');
    // The whole point: the bundle never reaches a visitor with no session.
    expect(page.text).not.toContain(SPA_MARKER);
  });

  it('passes the request, response and the configured base path', async () => {
    let seen: { basePath: string; hasRequest: boolean } | undefined;
    const server = await boot({
      path: 'observability',
      dashboardAuth: {
        secret: SECRET,
        session: () => null,
        unauthenticatedPage: ({ request: req, response, basePath }) => {
          seen = { basePath, hasRequest: typeof (req as { url?: unknown })?.url === 'string' };
          (response as HostResponse).status(401).send('ok');
        },
      },
    });

    await request(server).get('/observability').expect(401);
    // basePath must follow the configured mount, not the default — a host linking back to it would
    // otherwise send visitors to a path that does not exist.
    expect(seen).toEqual({ basePath: '/observability', hasRequest: true });
  });

  it('serves the SPA to a visitor holding a valid session cookie', async () => {
    const server = await boot({
      dashboardAuth: {
        secret: SECRET,
        session: () => ({ id: 'ops' }),
        unauthenticatedPage: ({ response }) => {
          (response as HostResponse).status(401).send('locked');
        },
      },
    });

    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 60_000 });
    const page = await request(server)
      .get('/telescope')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${cookie}`)
      .expect(200);

    expect(page.text).toContain(SPA_MARKER);
    expect(page.text).not.toContain('locked');
  });

  it('ignores a cookie signed with a different secret', async () => {
    const server = await boot({
      dashboardAuth: {
        secret: SECRET,
        session: () => null,
        unauthenticatedPage: ({ response }) => {
          (response as HostResponse).status(401).send('locked');
        },
      },
    });

    // A forged/stale cookie must not be enough to pull the bundle down.
    const forged = signSessionCookie({ id: 'ops' }, { secret: 'x'.repeat(32), ttlMs: 60_000 });
    const page = await request(server)
      .get('/telescope')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${forged}`)
      .expect(401);

    expect(page.text).toContain('locked');
  });

  it('is ignored under Mode B, where the SPA login form is the way in', async () => {
    const server = await boot({
      dashboardAuth: {
        secret: SECRET,
        login: () => ({ id: 'ops' }),
        unauthenticatedPage: ({ response }) => {
          (response as HostResponse).status(401).send('should never render');
        },
      },
    });

    // Gating the shell under Mode B would lock the host out of its own dashboard: the login form
    // the visitor needs is INSIDE the bundle this page would replace.
    const page = await request(server).get('/telescope').expect(200);
    expect(page.text).toContain(SPA_MARKER);
  });

  it('serves the shell unchanged when no dashboardAuth is passed to this module', async () => {
    // The default, and the case that must not regress: this module is normally configured with no
    // auth at all (core gates the API), so the shell stays public with no session check.
    const server = await boot({});
    const page = await request(server).get('/telescope').expect(200);
    expect(page.text).toContain(SPA_MARKER);
  });

  it('serves the shell when dashboardAuth is passed without a page hook', async () => {
    const server = await boot({ dashboardAuth: { secret: SECRET, session: () => null } });
    const page = await request(server).get('/telescope').expect(200);
    expect(page.text).toContain(SPA_MARKER);
  });

  it('falls back to the SPA when the host page throws', async () => {
    const server = await boot({
      dashboardAuth: {
        secret: SECRET,
        session: () => null,
        unauthenticatedPage: () => {
          throw new Error('template blew up');
        },
      },
    });

    // A broken host page must not turn a navigation into a 500. Falling back is safe: every data
    // route stays behind core's TelescopeGuard, so the visitor gets the built-in auth screen, not
    // the dashboard's contents.
    const page = await request(server).get('/telescope').expect(200);
    expect(page.text).toContain(SPA_MARKER);
  });

  it('falls back to the SPA when the host page writes nothing', async () => {
    const server = await boot({
      dashboardAuth: { secret: SECRET, session: () => null, unauthenticatedPage: () => {} },
    });

    // Otherwise the request hangs until the browser gives up, with nothing logged anywhere.
    const page = await request(server).get('/telescope').expect(200);
    expect(page.text).toContain(SPA_MARKER);
  });

  it('awaits an async host page rather than racing it', async () => {
    const server = await boot({
      dashboardAuth: {
        secret: SECRET,
        session: () => null,
        unauthenticatedPage: async ({ response }) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          (response as HostResponse).status(401).send('<html>async host page</html>');
        },
      },
    });

    // Without the await, the SPA would be served the moment the hook yielded — invisible with a
    // synchronous hook.
    const page = await request(server).get('/telescope').expect(401);
    expect(page.text).toContain('async host page');
    expect(page.text).not.toContain(SPA_MARKER);
  });

  it('still serves hashed assets — only the shell is gated', async () => {
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    const server = await boot({
      dashboardAuth: {
        secret: SECRET,
        session: () => null,
        unauthenticatedPage: ({ response }) => {
          (response as HostResponse).status(401).send('locked');
        },
      },
    });

    // Assets carry no data, and gating them would buy nothing while breaking a host page that
    // wanted to reuse them. Documenting the boundary so a future change is a deliberate one.
    await request(server).get('/telescope/assets/app.js').expect(200);
  });
});
