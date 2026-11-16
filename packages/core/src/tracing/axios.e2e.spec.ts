// Tracing across apps through `@nestjs/axios`'s HttpService, the usual way a Nest app calls out:
// every HttpService in the app (the default HttpModule and each HttpModule.register) carries the
// trace with no app code, a bare axios instance or a CustomAxiosSource can be handed over, the
// nodeHttp hook never adds a second header, and Fastify continues an incoming trace like Express.
import 'reflect-metadata';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpModule, HttpService } from '@nestjs/axios';
import { Controller, Get, type INestApplication, Inject, Injectable, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../entry/entry.js';
import { TelescopeModule } from '../nest/telescope.module.js';
import type { TelescopeModuleOptions } from '../nest/telescope.options.js';
import { runAsTelescopeWork } from '../otel/telescope-runtime.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { injectIntoAxiosConfig } from './axios.js';
import { resolvePropagation } from './config.js';
import { newTraceScope, runInTraceScope } from './scope.js';

const UPSTREAM_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const UPSTREAM = `00-${UPSTREAM_TRACE}-00f067aa0ba902b7-01`;

const seen: IncomingHttpHeaders[] = [];
let sink: Server;
let sinkOrigin = '';
const apps: INestApplication[] = [];

beforeEach(async () => {
  seen.length = 0;
  sink = createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
  sinkOrigin = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  sink.closeAllConnections();
  await new Promise((r) => sink.close(r));
});

/** A feature module with its own `HttpModule.register(...)`: a second HttpService. */
@Injectable()
class BillingClient {
  constructor(@Inject(HttpService) readonly http: HttpService) {}
}
@Module({
  imports: [HttpModule.register({ timeout: 5000 })],
  providers: [BillingClient],
  exports: [BillingClient],
})
class BillingModule {}

/** A bare axios instance the app hands over. */
const bare = axios.create();

@Controller()
class CallController {
  constructor(
    @Inject(HttpService) private readonly http: HttpService,
    @Inject(BillingClient) private readonly billing: BillingClient,
  ) {}

  @Get('default')
  async viaDefault(): Promise<unknown> {
    return (await firstValueFrom(this.http.get(`${sinkOrigin}/default`))).data;
  }

  @Get('registered')
  async viaRegistered(): Promise<unknown> {
    return (await firstValueFrom(this.billing.http.get('/registered', { baseURL: sinkOrigin })))
      .data;
  }

  @Get('bare')
  async viaBare(): Promise<unknown> {
    return (await bare.get(`${sinkOrigin}/bare`)).data;
  }

  @Get('own-header')
  async ownHeader(): Promise<unknown> {
    return (
      await firstValueFrom(
        this.http.get(`${sinkOrigin}/own`, { headers: { traceparent: UPSTREAM } }),
      )
    ).data;
  }
}

@Module({ imports: [HttpModule, BillingModule], controllers: [CallController] })
class Host {}

async function boot(options: TelescopeModuleOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot(options), Host],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  apps.push(app);
  await app.init();
  return app;
}

function traceparents(index: number): string | undefined {
  const value = seen[index]?.traceparent;
  return Array.isArray(value) ? value.join(', ') : value;
}

describe('tracing through @nestjs/axios HttpService', () => {
  it('adds the trace to every HttpService in the app, and to a handed-over instance', async () => {
    const storage = new InMemoryStorageProvider();
    const app = await boot({ storage, propagation: { targets: [sinkOrigin], axios: bare } });
    const server = app.getHttpServer();
    await request(server).get('/default').set('traceparent', UPSTREAM).expect(200);
    await request(server).get('/registered').set('traceparent', UPSTREAM).expect(200);
    await request(server).get('/bare').set('traceparent', UPSTREAM).expect(200);
    expect(seen).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(traceparents(i)).toMatch(new RegExp(`^00-${UPSTREAM_TRACE}-[0-9a-f]{16}-01$`));
    }
  });

  it('never sends two headers with the nodeHttp hook on too, and keeps the app’s own', async () => {
    const app = await boot({
      storage: new InMemoryStorageProvider(),
      propagation: { targets: [sinkOrigin], nodeHttp: true },
    });
    const server = app.getHttpServer();
    await request(server).get('/default').expect(200);
    await request(server).get('/own-header').expect(200);
    expect(traceparents(0)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(traceparents(1)).toBe(UPSTREAM);
  });

  it('sends nothing to a non-target, nor with `axios: false`', async () => {
    const offTarget = await boot({
      storage: new InMemoryStorageProvider(),
      propagation: { targets: ['https://billing.internal'] },
    });
    await request(offTarget.getHttpServer()).get('/default').expect(200);
    expect(traceparents(0)).toBeUndefined();
    await offTarget.close();
    apps.splice(apps.indexOf(offTarget), 1);

    const off = await boot({
      storage: new InMemoryStorageProvider(),
      propagation: { targets: [sinkOrigin], axios: false },
    });
    await request(off.getHttpServer()).get('/default').expect(200);
    expect(traceparents(1)).toBeUndefined();
  });

  it('takes an instance from a CustomAxiosSource', async () => {
    const lazy = axios.create();
    let resolvedWith: unknown;
    await boot({
      storage: new InMemoryStorageProvider(),
      propagation: {
        targets: [sinkOrigin],
        axios: {
          instrument(attach, ctx) {
            resolvedWith = ctx.moduleRef;
            attach(lazy);
          },
        },
      },
    });
    expect(resolvedWith).toBeDefined();
    await runInTraceScope(newTraceScope(), () => lazy.get(`${sinkOrigin}/lazy`));
    expect(traceparents(0)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});

describe('the axios interceptor rules', () => {
  const config = resolvePropagation({ targets: ['http://billing.internal'] }, false);
  const call = (over: Record<string, unknown> = {}) => ({
    url: '/x',
    baseURL: 'http://billing.internal/api',
    headers: {} as Record<string, unknown>,
    ...over,
  });

  it('matches baseURL + url, and adds nothing outside a trace or in telescope work', () => {
    const inTrace = call();
    runInTraceScope(newTraceScope(), () => injectIntoAxiosConfig(config, inTrace));
    expect(inTrace.headers.traceparent).toMatch(/^00-/);
    const outside = call();
    injectIntoAxiosConfig(config, outside);
    expect(outside.headers).toEqual({});
    const own = call();
    runInTraceScope(newTraceScope(), () =>
      runAsTelescopeWork(() => injectIntoAxiosConfig(config, own)),
    );
    expect(own.headers).toEqual({});
    const elsewhere = call({ url: 'https://api.stripe.com/v1' });
    runInTraceScope(newTraceScope(), () => injectIntoAxiosConfig(config, elsewhere));
    expect(elsewhere.headers).toEqual({});
  });

  it('adds nothing while an OpenTelemetry propagator writing traceparent is registered', () => {
    const key = Symbol.for('opentelemetry.js.api.1');
    const slot = globalThis as Record<symbol, unknown>;
    const previous = slot[key];
    slot[key] = { version: '1.9.0', propagation: { fields: () => ['traceparent'] } };
    try {
      const otel = call();
      runInTraceScope(newTraceScope(), () => injectIntoAxiosConfig(config, otel));
      expect(otel.headers).toEqual({});
    } finally {
      slot[key] = previous;
    }
  });
});

describe('incoming traces on Fastify', () => {
  it('continues the caller’s trace and passes it on through HttpService', async () => {
    const storage = new InMemoryStorageProvider();
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ storage, propagation: { targets: [sinkOrigin] } }), Host],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    apps.push(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const res = await app.inject({
      method: 'GET',
      url: '/default',
      headers: { traceparent: UPSTREAM },
    });
    expect(res.statusCode).toBe(200);
    expect(traceparents(0)).toMatch(new RegExp(`^00-${UPSTREAM_TRACE}-`));
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const [entry] = (await storage.get({ type: EntryType.Request, limit: 1 })).data;
    expect(entry?.traceId).toBe(UPSTREAM_TRACE);
    expect(entry?.content).toMatchObject({ parentSpanId: '00f067aa0ba902b7' });
  });
});
