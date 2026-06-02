// packages/core/src/http/http-client.watcher.e2e.spec.ts
import 'reflect-metadata';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { TelescopeModule } from '../nest/telescope.module.js';
import { TelescopeService } from '../nest/telescope.service.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { HttpClientWatcher } from './http-client.watcher.js';

let upstreamUrl = '';

@Controller('caller')
class CallerController {
  @Get()
  async call(): Promise<{ ok: boolean }> {
    await fetch(upstreamUrl);
    return { ok: true };
  }
}

describe('HttpClientWatcher e2e correlation', () => {
  let app: INestApplication;
  let upstream: Server;
  const originalFetch = globalThis.fetch;
  const storage = new InMemoryStorageProvider();

  beforeAll(async () => {
    upstream = createServer((_req, res) => res.end('hello'));
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/`;

    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          watchers: [new HttpClientWatcher()],
          storage,
        }),
      ],
      controllers: [CallerController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    globalThis.fetch = originalFetch; // restore the global the watcher patched
  });

  it('correlates an outbound fetch to the request batch', async () => {
    await request(app.getHttpServer()).get('/caller').expect(200);
    await app.get(TelescopeService).flush();

    const res = await request(app.getHttpServer()).get('/telescope/api/entries').expect(200);
    const entries: Entry[] = (res.body as { data: Entry[] }).data;

    const httpClient = entries.find((e) => e.type === 'http_client');
    const requestEntry = entries.find(
      (e) =>
        e.type === 'request' &&
        typeof (e.content as { uri?: unknown }).uri === 'string' &&
        (e.content as { uri: string }).uri.includes('caller'),
    );

    expect(httpClient).toBeDefined();
    expect(requestEntry).toBeDefined();
    expect(httpClient!.batchId).toBe(requestEntry!.batchId);
    expect((httpClient!.content as { host: string }).host).toBe(
      `127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    );
  });
});
