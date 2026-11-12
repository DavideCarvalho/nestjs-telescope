// packages/otel/src/span-processor.http-client.sdk.spec.ts
import 'reflect-metadata';
import type * as Http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import {
  type Entry,
  type HttpClientContent,
  HttpClientWatcher,
  InMemoryStorageProvider,
  type SpanContent,
  TelescopeModule,
  TelescopeService,
} from '@dudousxd/nestjs-telescope';
import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { context, trace } from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import type { AxiosInstance } from 'axios';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OtelTraceContextProvider } from './otel-trace-context-provider.js';
import { telescopeSpanProcessor } from './span-processor.js';

/**
 * axios through the http-client watcher next to `HttpInstrumentation`: each call is one
 * `http_client` entry or one client `span` entry, never both, and http calls the watcher
 * doesn't see (an SDK calling `http.request`) still come through as spans.
 */

const instrumentation = new HttpInstrumentation();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter()), telescopeSpanProcessor()],
});
provider.register();
instrumentation.setTracerProvider(provider);
instrumentation.enable();
// Require `http` and axios after enabling, so the instrumentation patches the module object.
const require = createRequire(import.meta.url);
const http = require('node:http') as typeof Http;
const axios = (require('axios') as { create(): AxiosInstance }).create();

const storage = new InMemoryStorageProvider();

@Module({
  imports: [
    TelescopeModule.forRoot({
      storage,
      traceContext: new OtelTraceContextProvider(),
      recorder: { flushIntervalMs: 60_000 },
      // Keep failed calls only: `/ok` entries are sampled out, `/fail` entries are kept.
      sampling: { http_client: { rate: 0, keepErrors: true } },
      watchers: [new HttpClientWatcher({ axios })],
    }),
  ],
})
class AppModule {}

/** An http call the watcher doesn't see, like the AWS SDK's. */
function plainGet(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on('end', () => resolve());
      })
      .on('error', reject);
  });
}

describe('telescopeSpanProcessor with axios through the http-client watcher', () => {
  let app: INestApplication;
  let target: Http.Server;
  let base: string;

  beforeAll(async () => {
    target = http.createServer((req, res) => {
      res.statusCode = req.url === '/fail' ? 503 : 200;
      res.end('{}');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => target.close(resolve));
    instrumentation.disable();
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it('records each axios call once, and keeps calls the watcher does not see', async () => {
    await trace.getTracer('app').startActiveSpan('job', async (job) => {
      await axios.get(`${base}/ok`);
      await axios.get(`${base}/fail`, { validateStatus: () => true });
      await plainGet(`${base}/sdk`);
      job.end();
    });
    await app.get(TelescopeService).flush();

    const all = (await storage.get({ limit: 500 })).data;
    const clientEntries = all
      .filter((e) => e.type === 'http_client')
      .map((e) => new URL((e as Entry<HttpClientContent>).content.url).pathname);
    const clientSpans = (all.filter((e) => e.type === 'span') as Entry<SpanContent>[])
      .filter((e) => e.content.kind === 'client')
      .map((e) => {
        const attributes = e.content.attributes;
        const url = attributes['url.full'] ?? attributes['http.url'];
        return typeof url === 'string' ? new URL(url).pathname : String(attributes['http.target']);
      });

    // `/fail` was kept as an entry, so its span is skipped. `/ok`'s entry was sampled out, so
    // its span stands in. `/sdk` has no entry at all.
    expect(clientEntries).toEqual(['/fail']);
    expect(clientSpans.sort()).toEqual(['/ok', '/sdk']);
  });
});
