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
});
