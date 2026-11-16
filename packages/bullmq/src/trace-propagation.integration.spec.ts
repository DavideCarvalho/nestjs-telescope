// packages/bullmq/src/trace-propagation.integration.spec.ts
//
// A real Redis, a real BullMQ worker, a real TelescopeModule with `propagation`: a job added
// inside a trace is stored with the trace in its own carrier, and the worker runs it in that trace,
// its entry naming the dispatching span as its parent. Redis as in the watcher's integration suite.
import 'reflect-metadata';
import type { Entry } from '@dudousxd/nestjs-telescope';
import {
  InMemoryStorageProvider,
  TelescopeModule,
  TelescopeService,
  newTraceScope,
  runInTraceScope,
} from '@dudousxd/nestjs-telescope';
import { BullModule, Processor, WorkerHost, getQueueToken } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Job, Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRedis } from '../test/redis-container.js';
import { BullMqJobWatcher } from './bullmq-job.watcher.js';

const redis = await startRedis();
const connection = redis?.connection ?? { host: '127.0.0.1', port: 6379 };
const QUEUE = 'telescope-trace-test';
const storage = new InMemoryStorageProvider();

@Processor(QUEUE)
class TraceProcessor extends WorkerHost {
  async process(_job: Job): Promise<string> {
    return 'done';
  }
}

@Module({
  imports: [
    TelescopeModule.forRoot({
      storage,
      propagation: {},
      watchers: [new BullMqJobWatcher()],
    }),
    BullModule.forRoot({ connection }),
    BullModule.registerQueue({ name: QUEUE }),
  ],
  providers: [TraceProcessor],
})
class AppModule {}

describe.skipIf(!redis)(`BullMQ trace propagation (real Redis: ${redis?.describedAs})`, () => {
  let app: TestingModule;
  let queue: Queue;
  let telescope: TelescopeService;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    telescope = app.get(TelescopeService);
    await app.init();
    queue = app.get<Queue>(getQueueToken(QUEUE));
    await queue.obliterate({ force: true }).catch(() => {});
  }, 120_000);

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => {});
    await app?.close();
    await redis?.stop();
  }, 60_000);

  it('runs a job in the trace that dispatched it', async () => {
    const scope = newTraceScope();
    const added = await runInTraceScope(scope, () => queue.add('traced', { n: 1 }));
    const stored = await queue.getJob(added.id as string);
    expect(stored?.opts.telemetry?.metadata).toContain(scope.fallbackTraceId);

    let entry: Entry | undefined;
    for (let i = 0; i < 150 && entry === undefined; i++) {
      await telescope.flush();
      entry = (await storage.get({ type: 'job', limit: 10 })).data[0];
      if (entry === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(entry?.traceId).toBe(scope.fallbackTraceId);
    expect(entry?.content).toMatchObject({ name: 'traced', parentSpanId: scope.spanId });
  }, 60_000);
});
