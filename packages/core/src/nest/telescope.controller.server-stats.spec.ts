// packages/core/src/nest/telescope.controller.server-stats.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';

describe('GET /telescope/api/server-stats', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          storage,
          instanceId: 'instance-xyz',
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns a finite process-health snapshot', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/api/server-stats').expect(200);
    const body = res.body as {
      uptimeSec: number;
      memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
      cpu: { userMs: number; systemMs: number };
      eventLoopDelayMs: number | null;
      instanceId: string;
    };
    expect(body.instanceId).toBe('instance-xyz');
    expect(Number.isFinite(body.uptimeSec)).toBe(true);
    expect(body.memory.rssMb).toBeGreaterThan(0);
    expect(Number.isFinite(body.memory.heapUsedMb)).toBe(true);
    expect(Number.isFinite(body.memory.heapTotalMb)).toBe(true);
    expect(Number.isFinite(body.cpu.userMs)).toBe(true);
    expect(Number.isFinite(body.cpu.systemMs)).toBe(true);
    expect(body.eventLoopDelayMs === null || Number.isFinite(body.eventLoopDelayMs)).toBe(true);
  });

  it('is gated by the read guard (403 when unauthorized)', async () => {
    const denied = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ enabled: true, authorizer: () => false, storage })],
    }).compile();
    const deniedApp = denied.createNestApplication();
    await deniedApp.init();
    await request(deniedApp.getHttpServer()).get('/telescope/api/server-stats').expect(403);
    await deniedApp.close();
  });
});
