import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { EntryQuery, Page } from '../storage/storage-provider.js';
import { TelescopeModule } from './telescope.module.js';

/** A store that answers every listing from a subset of its data. */
class PartialStorage extends InMemoryStorageProvider {
  override async get(query: EntryQuery): Promise<Page<Entry>> {
    return { ...(await super.get(query)), partial: true };
  }
}

describe('Page.partial over HTTP', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(storage: InMemoryStorageProvider): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true, storage })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app;
  }

  it('passes partial through the entries and profiles listings', async () => {
    const server = (await boot(new PartialStorage())).getHttpServer();
    expect((await request(server).get('/telescope/api/entries').expect(200)).body.partial).toBe(
      true,
    );
    expect((await request(server).get('/telescope/api/profiles').expect(200)).body.partial).toBe(
      true,
    );
  });

  it('leaves it absent for a complete answer', async () => {
    const server = (await boot(new InMemoryStorageProvider())).getHttpServer();
    const body = (await request(server).get('/telescope/api/entries').expect(200)).body;
    expect(body).not.toHaveProperty('partial');
  });
});
