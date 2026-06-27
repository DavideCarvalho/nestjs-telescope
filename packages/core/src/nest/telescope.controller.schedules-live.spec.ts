// packages/core/src/nest/telescope.controller.schedules-live.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScheduleManager, ScheduledTask } from '../schedule/schedule-manager.js';
import { TelescopeModule } from './telescope.module.js';

const TASKS: ScheduledTask[] = [
  {
    name: 'nightly-report',
    kind: 'cron',
    schedule: '0 0 * * *',
    nextRunAt: '2026-06-04T00:00:00.000Z',
    running: true,
    lastRunAt: '2026-06-03T00:00:00.000Z',
    lastDurationMs: 1200,
    lastStatus: 'completed',
  },
  {
    name: 'heartbeat',
    kind: 'interval',
    schedule: 'every 5000ms',
    nextRunAt: null,
    running: null,
    lastRunAt: null,
    lastDurationMs: null,
    lastStatus: null,
  },
];

const fakeManager: ScheduleManager = {
  listTasks: (): Promise<ScheduledTask[]> => Promise.resolve(TASKS),
};

describe('GET /telescope/api/schedules/live', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          scheduleManagers: [fakeManager],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists registered scheduled tasks across managers', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/api/schedules/live').expect(200);
    expect(res.body).toEqual({ tasks: TASKS });
  });
});

describe('GET /telescope/api/schedules/live (read-guarded)', () => {
  it('denies when the authorizer denies', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => false,
          scheduleManagers: [fakeManager],
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer()).get('/telescope/api/schedules/live').expect(403);
    } finally {
      await app.close();
    }
  });
});

describe('GET /telescope/api/schedules/live (no manager configured)', () => {
  it('returns an empty task list', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ enabled: true, authorizer: () => true })],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const res = await request(app.getHttpServer())
        .get('/telescope/api/schedules/live')
        .expect(200);
      expect(res.body).toEqual({ tasks: [] });
    } finally {
      await app.close();
    }
  });
});
