import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';
import { TELESCOPE_STORAGE } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

describe('TelescopeModule.forRootAsync (async options applied)', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app?.close();
  });

  const STORAGE_SOURCE = Symbol('STORAGE_SOURCE');
  const memory = new InMemoryStorageProvider();

  @Module({
    providers: [{ provide: STORAGE_SOURCE, useValue: memory }],
    exports: [STORAGE_SOURCE],
  })
  class ConfigModule {}

  it('resolves storage + authorizer via imports/inject/useFactory and applies them', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRootAsync({
          imports: [ConfigModule],
          inject: [STORAGE_SOURCE],
          useFactory: (storage: InMemoryStorageProvider) => ({ storage, authorizer: () => true }),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    // The DI-resolved storage provider is the exact instance from the factory,
    // not the default SqliteStorageProvider.
    expect(app.get(TELESCOPE_STORAGE)).toBe(memory);

    const service = app.get(TelescopeService);
    await service.runInBatch('http', async () => {
      service.record({ type: 'request', content: { statusCode: 200 } });
    });
    await service.flush();

    // Recorded entry landed in the async-resolved store and is served via the
    // authorizer:() => true-gated API.
    const res = await request(app.getHttpServer()).get('/telescope/api/entries').expect(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].type).toBe('request');
  });

  it('denies the API when the async authorizer resolves to false', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRootAsync({
          useFactory: () => ({ authorizer: () => false }),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).get('/telescope/api/meta').expect(403);
  });
});
