// packages/core/src/nest/telescope.controller.health.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';

describe('GET /telescope/api/health', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          storage,
          instanceId: 'instance-health',
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns the self-metrics snapshot with a finite capture cost', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/api/health').expect(200);
    const body = res.body as {
      enabled: boolean;
      recorded: number;
      bufferSize: number;
      bufferUsed: number;
      bufferHighWater: number;
      flushes: number;
      flushedEntries: number;
      lastFlushMs: number | null;
      maxFlushMs: number | null;
      totalFlushMs: number;
      overflowDropped: number;
      storeFailedDropped: number;
      droppedCount: number;
      captureCostNanos: number;
    };
    expect(body.enabled).toBe(true);
    expect(Number.isFinite(body.recorded)).toBe(true);
    expect(body.bufferSize).toBeGreaterThan(0);
    expect(Number.isFinite(body.bufferUsed)).toBe(true);
    expect(Number.isFinite(body.bufferHighWater)).toBe(true);
    expect(Number.isFinite(body.flushes)).toBe(true);
    expect(Number.isFinite(body.flushedEntries)).toBe(true);
    expect(body.lastFlushMs === null || Number.isFinite(body.lastFlushMs)).toBe(true);
    expect(body.maxFlushMs === null || Number.isFinite(body.maxFlushMs)).toBe(true);
    expect(Number.isFinite(body.totalFlushMs)).toBe(true);
    expect(body.droppedCount).toBeGreaterThanOrEqual(
      body.overflowDropped + body.storeFailedDropped,
    );
    expect(body.captureCostNanos).toBeGreaterThan(0);
  });

  it('is gated by the read guard (403 when unauthorized)', async () => {
    const denied = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ enabled: true, authorizer: () => false, storage })],
    }).compile();
    const deniedApp = denied.createNestApplication();
    await deniedApp.init();
    await request(deniedApp.getHttpServer()).get('/telescope/api/health').expect(403);
    await deniedApp.close();
  });
});
