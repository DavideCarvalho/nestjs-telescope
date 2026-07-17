// packages/core/src/nest/client-error.controller.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { EntryType } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

const ENDPOINT = '/telescope/api/client-errors';

async function makeApp(
  options: TelescopeModuleOptions,
): Promise<{ app: INestApplication; storage: InMemoryStorageProvider }> {
  const storage = new InMemoryStorageProvider();
  const moduleRef = await Test.createTestingModule({
    imports: [
      TelescopeModule.forRoot({
        storage,
        // Tiny flush interval so a recorded entry lands in storage promptly.
        recorder: { flushIntervalMs: 5 },
        ...options,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, storage };
}

/** Flush the recorder and read back the stored client_exception entries. */
async function clientEntries(
  app: INestApplication,
  storage: InMemoryStorageProvider,
): Promise<Awaited<ReturnType<InMemoryStorageProvider['get']>>['data']> {
  await app.get(TelescopeService).flush();
  const page = await storage.get({ type: EntryType.ClientException });
  return page.data;
}

describe('ClientErrorController', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 404 when clientErrors is disabled (default)', async () => {
    const built = await makeApp({});
    app = built.app;
    await request(app.getHttpServer()).post(ENDPOINT).send({ message: 'boom' }).expect(404);
  });

  it('returns 404 when explicitly enabled: false', async () => {
    const built = await makeApp({ clientErrors: { enabled: false } });
    app = built.app;
    await request(app.getHttpServer()).post(ENDPOINT).send({ message: 'boom' }).expect(404);
  });

  it('happy path: 204 and records a client_exception with family hash + tags', async () => {
    const built = await makeApp({ clientErrors: { enabled: true } });
    app = built.app;
    await request(app.getHttpServer())
      .post(ENDPOINT)
      .send({
        message: 'Cannot read properties of undefined',
        name: 'TypeError',
        stack: 'TypeError: x\n    at foo (app.js:1:1)\n    at bar (app.js:2:2)',
        url: 'https://app.example.com/dashboard',
        userAgent: 'Mozilla/5.0',
        user: { id: 'user-42' },
      })
      .expect(204);

    const entries = await clientEntries(app, built.storage);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.type).toBe(EntryType.ClientException);
    // name + message + top frame.
    expect(entry?.familyHash).toBe(
      'TypeError:Cannot read properties of undefined:at foo (app.js:1:1)',
    );
    expect(entry?.tags).toContain('failed');
    expect(entry?.tags).toContain('client');
    expect(entry?.tags).toContain('user:user-42');
  });

  it('captures the client IP from x-forwarded-for first hop into content.clientIp', async () => {
    const built = await makeApp({ clientErrors: { enabled: true } });
    app = built.app;
    await request(app.getHttpServer())
      .post(ENDPOINT)
      .set('x-forwarded-for', '203.0.113.7, 10.0.0.1')
      .send({ message: 'boom' })
      .expect(204);

    const entries = await clientEntries(app, built.storage);
    const content = entries[0]?.content;
    expect(
      content !== null && typeof content === 'object' ? Reflect.get(content, 'clientIp') : null,
    ).toBe('203.0.113.7');
  });

  it('rejects an invalid body (missing message) with 400 and no echo', async () => {
    const built = await makeApp({ clientErrors: { enabled: true } });
    app = built.app;
    const res = await request(app.getHttpServer())
      .post(ENDPOINT)
      .send({ name: 'TypeError', secret: 'do-not-reflect' })
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain('do-not-reflect');
  });

  it('rejects a non-string message with 400', async () => {
    const built = await makeApp({ clientErrors: { enabled: true } });
    app = built.app;
    await request(app.getHttpServer()).post(ENDPOINT).send({ message: 42 }).expect(400);
  });

  it('rejects a body over maxBodyBytes with 413', async () => {
    const built = await makeApp({ clientErrors: { enabled: true, maxBodyBytes: 64 } });
    app = built.app;
    await request(app.getHttpServer())
      .post(ENDPOINT)
      .send({ message: 'x'.repeat(500) })
      .expect(413);
  });

  it('rate limits over the per-minute budget with 429', async () => {
    const built = await makeApp({ clientErrors: { enabled: true, rateLimit: { perMinute: 2 } } });
    app = built.app;
    const server = app.getHttpServer();
    await request(server).post(ENDPOINT).send({ message: 'a' }).expect(204);
    await request(server).post(ENDPOINT).send({ message: 'b' }).expect(204);
    await request(server).post(ENDPOINT).send({ message: 'c' }).expect(429);
  });

  it('authorize hook denies with 403 when it returns false', async () => {
    const built = await makeApp({
      clientErrors: { enabled: true, authorize: () => false },
    });
    app = built.app;
    await request(app.getHttpServer()).post(ENDPOINT).send({ message: 'boom' }).expect(403);
  });

  it('authorize hook allows when it returns true', async () => {
    const built = await makeApp({
      clientErrors: { enabled: true, authorize: () => true },
    });
    app = built.app;
    await request(app.getHttpServer()).post(ENDPOINT).send({ message: 'boom' }).expect(204);
  });

  it('authorize hook that throws is treated as a denial (403), never a 500', async () => {
    const built = await makeApp({
      clientErrors: {
        enabled: true,
        authorize: () => {
          throw new Error('hook blew up');
        },
      },
    });
    app = built.app;
    await request(app.getHttpServer()).post(ENDPOINT).send({ message: 'boom' }).expect(403);
  });

  it('authorize hook reads headers/user directly (typed request, no structural cast)', async () => {
    const built = await makeApp({
      clientErrors: {
        enabled: true,
        // `request` is typed `TelescopeHttpRequest` (not `unknown`) — headers
        // are readable without a hand-rolled guard.
        authorize: (req) => req.headers?.['x-allow'] === 'yes',
      },
    });
    app = built.app;
    await request(app.getHttpServer()).post(ENDPOINT).send({ message: 'boom' }).expect(403);
    await request(app.getHttpServer())
      .post(ENDPOINT)
      .set('x-allow', 'yes')
      .send({ message: 'boom' })
      .expect(204);
  });

  it('keeps clientIp/url/userAgent when a huge componentStack would exhaust the redaction budget', async () => {
    // A deeply-nested React error boundary produces a componentStack of many KB.
    // The short enrichment fields the Slack alert renders (clientIp/url/userAgent)
    // must NOT be starved out of the content by that big string — they are
    // ordered ahead of the stacks so the byte budget covers them first.
    const built = await makeApp({
      clientErrors: { enabled: true },
      redact: { maxContentBytes: 2_000 },
    });
    app = built.app;
    const componentStack = 'at Component\n'.repeat(600); // ~7.8 KB, well over budget

    await request(app.getHttpServer())
      .post(ENDPOINT)
      .set('x-forwarded-for', '203.0.113.7')
      .send({
        message: 'f.map is not a function',
        name: 'TypeError',
        url: 'https://dev.example/dashboard/vehicle-statistics',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
        componentStack,
      })
      .expect(204);

    const entries = await clientEntries(app, built.storage);
    const content = entries[0]?.content as Record<string, unknown> | undefined;
    expect(content?.clientIp).toBe('203.0.113.7');
    expect(content?.url).toBe('https://dev.example/dashboard/vehicle-statistics');
    expect(content?.userAgent).toBe('Mozilla/5.0 (Windows NT 10.0)');
  });

  it('honors redact.perType to give client_exception a larger content budget than the global', async () => {
    // Global budget is punishingly small (protects high-volume request/cache
    // entries); the rare, high-value client_exception gets its own generous
    // budget so its whole componentStack survives.
    const built = await makeApp({
      clientErrors: { enabled: true },
      redact: {
        maxContentBytes: 50,
        perType: { [EntryType.ClientException]: { maxContentBytes: 32_768 } },
      },
    });
    app = built.app;
    const componentStack = 'at Component\n'.repeat(600);

    await request(app.getHttpServer())
      .post(ENDPOINT)
      .set('x-forwarded-for', '203.0.113.7')
      .send({ message: 'boom', componentStack })
      .expect(204);

    const entries = await clientEntries(app, built.storage);
    const content = entries[0]?.content as Record<string, unknown> | undefined;
    expect(content?.clientIp).toBe('203.0.113.7');
    expect((content?.componentStack as string | undefined)?.length).toBe(componentStack.length);
  });
});
