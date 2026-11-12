// packages/otel/src/span-processor.sdk.spec.ts
import 'reflect-metadata';
import type * as Http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import {
  type Entry,
  InMemoryStorageProvider,
  type SpanContent,
  TelescopeModule,
  TelescopeService,
} from '@dudousxd/nestjs-telescope';
import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { context, trace } from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OtelTraceContextProvider } from './otel-trace-context-provider.js';
import { telescopeSpanProcessor } from './span-processor.js';

/**
 * A real OpenTelemetry SDK (NodeTracerProvider + the http instrumentation) feeding a real Nest
 * app with Telescope: the app's spans become `span` entries in the request's trace, the HTTP
 * server span is left to the request middleware, Telescope's own storage makes no spans, and
 * the dashboard's requests stay out.
 */

const instrumentation = new HttpInstrumentation();
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter), telescopeSpanProcessor()],
});
provider.register();
instrumentation.setTracerProvider(provider);
instrumentation.enable();
// Require `http` after enabling, so the instrumentation patches the module object.
const http = createRequire(import.meta.url)('node:http') as typeof Http;

@Controller('orders')
class OrdersController {
  @Get()
  async list(): Promise<{ ok: true }> {
    await trace.getTracer('app').startActiveSpan('load orders', async (span) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      span.end();
    });
    return { ok: true };
  }
}

/** A store whose writes make a span, like a DB driver under an instrumentation would. */
class TracedStorage extends InMemoryStorageProvider {
  override async store(batch: Entry[]): Promise<void> {
    trace.getTracer('db-driver').startSpan('storage write').end();
    await super.store(batch);
  }
}

const storage = new TracedStorage();

@Module({
  imports: [
    TelescopeModule.forRoot({
      storage,
      traceContext: new OtelTraceContextProvider(),
      recorder: { flushIntervalMs: 60_000 },
    }),
  ],
  controllers: [OrdersController],
})
class AppModule {}

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // An outgoing call from outside any span: the client span is the root of the trace.
    context.with(trace.deleteSpan(context.active()), () => {
      http
        .get({ host: '127.0.0.1', port, path }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        })
        .on('error', reject);
    });
  });
}

async function entries(): Promise<Entry[]> {
  const page = await storage.get({ limit: 500 });
  return page.data;
}

describe('telescopeSpanProcessor with a real OpenTelemetry SDK', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
    instrumentation.disable();
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it("puts the app's spans in the request's trace and leaves the server span to the middleware", async () => {
    expect(await get(port, '/orders')).toBe(200);
    await app.get(TelescopeService).flush();

    const all = await entries();
    const request = all.find((e) => e.type === 'request');
    expect(request?.traceId).toMatch(/^[0-9a-f]{32}$/);

    const spans = all.filter((e) => e.type === 'span') as Entry<SpanContent>[];
    const load = spans.find((e) => e.content.name === 'load orders');
    expect(load?.traceId).toBe(request?.traceId);
    expect(load?.spanId).toBe(load?.content.spanId);
    // The server span is the request entry's; the outgoing client span (no watcher records
    // it here) comes through.
    expect(spans.some((e) => e.content.kind === 'server')).toBe(false);
    expect(spans.some((e) => e.content.kind === 'client')).toBe(true);
  });

  it("makes no spans for Telescope's own storage work", async () => {
    exporter.reset();
    await app.get(TelescopeService).flush();
    const service = app.get(TelescopeService);
    service.record({ type: 'dump', content: { label: null, value: 1 } });
    await trace.getTracer('app').startActiveSpan('outer', async (span) => {
      await service.flush();
      span.end();
    });
    const exported = exporter.getFinishedSpans().map((s) => s.name);
    expect(exported).toEqual(['outer']);
  });

  it('keeps requests to the dashboard out', async () => {
    await app.get(TelescopeService).flush();
    await storage.clear();
    await get(port, '/telescope/api/meta');
    await app.get(TelescopeService).flush();
    const spans = (await entries()).filter((e) => e.type === 'span') as Entry<SpanContent>[];
    expect(spans).toEqual([]);
  });

  it('lists `span` among the watched types', async () => {
    const meta = await app.get(TelescopeService).getMeta();
    expect(meta.watchers).toContain('span');
  });
});
