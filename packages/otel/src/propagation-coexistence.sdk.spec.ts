// packages/otel/src/propagation-coexistence.sdk.spec.ts
import 'reflect-metadata';
import diagnostics_channel from 'node:diagnostics_channel';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EntryType,
  InMemoryStorageProvider,
  TelescopeModule,
  TelescopeService,
} from '@dudousxd/nestjs-telescope';
import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { context, propagation } from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OtelTraceContextProvider } from './otel-trace-context-provider.js';

/**
 * Telescope's tracing across apps next to OpenTelemetry: while a propagator is registered, OTel
 * owns `traceparent` (one header per call, never two) and continues the incoming trace, and
 * telescope's entries use OTel's ids, the request naming the caller's span as its parent.
 */

const UPSTREAM_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const UPSTREAM_SPAN = '00f067aa0ba902b7';

const instrumentation = new HttpInstrumentation();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
});
provider.register();
instrumentation.setTracerProvider(provider);
instrumentation.enable();

/**
 * What `@opentelemetry/instrumentation-undici` does on the same channel: inject with the global
 * propagator, without looking at the headers already there. Subscribed AFTER telescope, so a
 * telescope header would make two.
 */
function otelUndiciLike(message: unknown): void {
  const req = (message as { request: { addHeader(name: string, value: string): void } }).request;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  for (const [name, value] of Object.entries(carrier)) req.addHeader(name, value);
}

const seen: IncomingHttpHeaders[] = [];
const sink: Server = createServer((req, res) => {
  seen.push(req.headers);
  res.end('{}');
});
const storage = new InMemoryStorageProvider();
let sinkOrigin = '';

@Controller()
class CallController {
  @Get('call')
  async call(): Promise<{ ok: boolean }> {
    const response = await fetch(`${sinkOrigin}/x`);
    await response.text();
    return { ok: response.ok };
  }
}

describe('tracing across apps next to OpenTelemetry', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    sinkOrigin = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    @Module({
      imports: [
        TelescopeModule.forRoot({
          storage,
          traceContext: new OtelTraceContextProvider(),
          propagation: { targets: [sinkOrigin] },
        }),
      ],
      controllers: [CallController],
    })
    class AppModule {}
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    diagnostics_channel.subscribe('undici:request:create', otelUndiciLike);
  });

  afterAll(async () => {
    diagnostics_channel.unsubscribe('undici:request:create', otelUndiciLike);
    await app.close();
    await new Promise((r) => sink.close(r));
    instrumentation.disable();
    await provider.shutdown();
  });

  it('sends one traceparent, continues the caller, and records OTel ids', async () => {
    const http = await import('node:http');
    await new Promise<void>((resolve, reject) => {
      http
        .get(
          `${base}/call`,
          { headers: { traceparent: `00-${UPSTREAM_TRACE}-${UPSTREAM_SPAN}-01` } },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        )
        .on('error', reject);
    });
    await app.get(TelescopeService).flush();

    const call = seen.find((headers) => headers.traceparent !== undefined);
    const value = call?.traceparent;
    expect(typeof value).toBe('string');
    // One header (Node joins duplicates with ", "), in the caller's trace.
    expect(value).not.toContain(',');
    expect(value).toMatch(new RegExp(`^00-${UPSTREAM_TRACE}-[0-9a-f]{16}-01$`));

    const [request] = (await storage.get({ type: EntryType.Request, limit: 1 })).data;
    expect(request?.traceId).toBe(UPSTREAM_TRACE);
    expect(request?.content).toMatchObject({ parentSpanId: UPSTREAM_SPAN });
  });
});
