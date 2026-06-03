// packages/core/src/nest/telescope.controller.queues-live.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  JobPage,
  QueueCounts,
  QueueJobDetail,
  QueueManager,
  QueueSummary,
} from '../queue/queue-manager.js';
import { TelescopeModule } from './telescope.module.js';

const COUNTS: QueueCounts = {
  waiting: 3,
  active: 1,
  delayed: 0,
  failed: 2,
  completed: 10,
  paused: 0,
};

const SUMMARY: QueueSummary = {
  driver: 'bull',
  queue: 'q1',
  counts: COUNTS,
  isPaused: false,
};

const FAILED_PAGE: JobPage = {
  jobs: [
    {
      id: '7',
      name: 'send-email',
      state: 'failed',
      attemptsMade: 3,
      maxAttempts: 3,
      timestamp: 1,
      processedOn: 2,
      finishedOn: 3,
      failedReason: 'SMTP down',
      progress: null,
    },
  ],
  nextCursor: null,
  total: null,
};

const JOB_DETAIL: QueueJobDetail = {
  id: '123',
  name: 'send-email',
  state: 'completed',
  attemptsMade: 1,
  maxAttempts: 3,
  timestamp: 1,
  processedOn: 2,
  finishedOn: 3,
  failedReason: null,
  progress: 100,
  data: { to: 'a@b.c' },
  opts: { attempts: 3 },
  stacktrace: null,
  returnValue: { ok: true },
};

const fakeManager: QueueManager = {
  driver: 'bull',
  init: () => {},
  listQueues: (): Promise<QueueSummary[]> => Promise.resolve([SUMMARY]),
  counts: (): Promise<QueueCounts> => Promise.resolve(COUNTS),
  listJobs: (): Promise<JobPage> => Promise.resolve(FAILED_PAGE),
  getJob: (): Promise<QueueJobDetail | null> => Promise.resolve(JOB_DETAIL),
};

describe('GET /telescope/api/queues/live/*', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          queueManagers: [fakeManager],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists live queues across drivers', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/api/queues/live').expect(200);
    expect(res.body).toEqual({ queues: [SUMMARY] });
  });

  it('returns counts for a known driver/queue', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/queues/live/bull/q1/counts')
      .expect(200);
    expect(res.body).toEqual(COUNTS);
  });

  it('returns a job page for a valid state', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/queues/live/bull/q1/jobs?state=failed')
      .expect(200);
    expect(res.body).toEqual(FAILED_PAGE);
  });

  it('rejects an invalid state with 400', async () => {
    await request(app.getHttpServer())
      .get('/telescope/api/queues/live/bull/q1/jobs?state=bogus')
      .expect(400);
  });

  it('returns 404 for an unknown driver', async () => {
    await request(app.getHttpServer()).get('/telescope/api/queues/live/nope/q1/counts').expect(404);
  });

  it('returns a single job detail', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/queues/live/bull/q1/jobs/123')
      .expect(200);
    expect(res.body).toEqual(JOB_DETAIL);
  });
});
