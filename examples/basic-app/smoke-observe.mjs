// Scratch harness: boots a real Nest app with Telescope + the Observe exporter,
// drives real traffic through it, and reports exactly what the collector said.
//
// Credentials come from the environment only:
//   OBSERVE_APP_KEY, OBSERVE_APP_SECRET, OBSERVE_SERVICE_ID
//   OBSERVE_ENDPOINT   optional — point at a local mock instead of the real one
//
// Not part of the package. Delete when done.

import 'reflect-metadata';
console.log('[smoke] module evaluating');
import {
  InMemoryStorageProvider,
  TelescopeModule,
  TelescopeService,
  telescopeRecord,
  telescopeRequestCapture,
} from '@dudousxd/nestjs-telescope';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const OBSERVE_DIST =
  '/home/dudousxd/personal/oss/nestjs/nestjs-telescope/packages/observe/dist/index.js';
const { ObserveExporter } = await import(OBSERVE_DIST);

const PORT = 3111;
const sentPayloads = [];
const responses = [];

/** Wraps global fetch so the harness can show the decoded body and the verdict. */
const { gunzipSync } = await import('node:zlib');
const observingFetch = async (url, init) => {
  const body = JSON.parse(gunzipSync(init.body).toString('utf8'));
  sentPayloads.push(body);
  const response = await fetch(url, init);
  const text = await response.text();
  responses.push({ status: response.status, body: text.slice(0, 8000) });
  return { ok: response.ok, status: response.status, text: async () => text };
};

const exporter = new ObserveExporter({
  appKey: process.env.OBSERVE_APP_KEY,
  appSecret: process.env.OBSERVE_APP_SECRET,
  serviceId: process.env.OBSERVE_SERVICE_ID,
  serviceVersion: 'smoke-1',
  ...(process.env.OBSERVE_ENDPOINT ? { endpoint: process.env.OBSERVE_ENDPOINT } : {}),
  fetch: observingFetch,
  batchGraceMs: 500,
  flushIntervalMs: 500,
  logger: { warn: (m) => console.log(`  [exporter] ${m}`) },
});

class SmokeController {
  async order() {
    // Children a real watcher would produce, with honest durations.
    await sleep(12);
    telescopeRecord({
      type: 'query',
      content: {
        sql: 'select * from orders where id = ?',
        bindings: [42],
        connection: 'default',
        slow: false,
      },
      durationMs: 12,
    });
    await sleep(3);
    telescopeRecord({
      type: 'cache',
      content: { operation: 'get', key: 'order:42', hit: true, tier: 'l1' },
      durationMs: 3,
    });
    telescopeRecord({
      type: 'log',
      content: { level: 'warn', message: 'order 42 served from cache', context: 'OrdersService' },
      durationMs: null,
    });
    return { id: 42 };
  }

  boom() {
    throw new Error('smoke: deliberate failure');
  }

  async job() {
    return { ok: true };
  }

  async unusedJob() {
    telescopeRecord({
      type: 'job',
      content: {
        id: 'job-smoke-1',
        name: 'send-invoice',
        queue: 'emails',
        payload: null,
        status: 'completed',
        attempts: 1,
        maxAttempts: 3,
        waitMs: 250,
        failureReason: null,
      },
      durationMs: 40,
      tags: ['queue:emails', 'job:send-invoice'],
    });
  }
}

class SmokeModule {}

// Node has no decorator support in .mjs, and Nest's decorators are ordinary
// functions that write metadata — so they are applied by hand here.
Controller()(SmokeController);
for (const [method, path] of [
  ['order', 'orders/42'],
  ['boom', 'boom'],
  ['job', 'jobs/run'],
]) {
  Get(path)(
    SmokeController.prototype,
    method,
    Object.getOwnPropertyDescriptor(SmokeController.prototype, method),
  );
}
Module({
  // In-memory rather than the default SQLite: the smoke only needs entries to
  // reach the extension hook, and the native module is built for another Node.
  imports: [
    TelescopeModule.forRoot({
      storage: new InMemoryStorageProvider(),
      registerRequestMiddleware: false,
      extensions: [exporter],
    }),
  ],
  controllers: [SmokeController],
})(SmokeModule);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (const key of ['OBSERVE_APP_KEY', 'OBSERVE_APP_SECRET', 'OBSERVE_SERVICE_ID']) {
    if (!process.env[key]) throw new Error(`${key} is not set`);
  }

  console.log('[smoke] creating app');
  const app = await NestFactory.create(SmokeModule, { logger: ['error', 'warn'] });
  app.use(telescopeRequestCapture(app.get(TelescopeService)));
  await app.listen(PORT);
  console.log(`\n→ endpoint: ${process.env.OBSERVE_ENDPOINT ?? 'https://observe-api.nestjs.com'}`);
  console.log(`→ serviceId: ${process.env.OBSERVE_SERVICE_ID}\n`);

  // A real queue run opens its own batch with origin 'queue', which is what
  // makes the job entry a root rather than a span inside some request.
  const telescope = app.get(TelescopeService);
  await telescope.runInBatch('queue', async () => {
    await sleep(8);
    telescopeRecord({
      type: 'query',
      content: {
        sql: 'select * from invoices where id = ?',
        bindings: [7],
        connection: 'default',
        slow: false,
      },
      durationMs: 8,
    });
    telescopeRecord({
      type: 'job',
      content: {
        id: 'job-smoke-1',
        name: 'send-invoice',
        queue: 'emails',
        payload: null,
        status: 'completed',
        attempts: 1,
        maxAttempts: 3,
        waitMs: 250,
        failureReason: null,
      },
      durationMs: 40,
      tags: ['queue:emails', 'job:send-invoice'],
    });
  });

  console.log('driving traffic...');
  for (const path of ['orders/42', 'orders/42', 'boom']) {
    const res = await fetch(`http://127.0.0.1:${PORT}/${path}`).catch(() => null);
    console.log(`  GET /${path} -> ${res ? res.status : 'error'}`);
  }

  // Let the Recorder flush (1s) and the assembler's grace window elapse.
  await sleep(3000);
  await exporter.close();
  await sleep(500);

  console.log(`\n=== POSTed ${sentPayloads.length} payload(s) ===`);
  for (const [i, payload] of sentPayloads.entries()) {
    console.log(`\n--- payload ${i + 1} -> HTTP ${responses[i]?.status} ---`);
    console.log(JSON.stringify(payload, null, 2));
    if (responses[i] && responses[i].status >= 400) {
      console.log(`  collector said: ${responses[i].body}`);
    }
  }

  console.log('\n=== exporter metrics ===');
  console.log(exporter.metrics);

  await app.close();
  const worst = Math.max(0, ...responses.map((r) => r.status));
  console.log(`\nRESULT: ${worst < 400 ? 'ACCEPTED' : `REJECTED (${worst})`}`);
  process.exit(worst < 400 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
