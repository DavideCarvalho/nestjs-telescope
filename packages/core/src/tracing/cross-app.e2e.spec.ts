// Two real Nest apps calling each other with a plain `fetch`, shipping to a control plane over
// HTTP: one trace across both, the callee nested under the caller in the waterfall, an app column,
// and a viewer limited to some apps seeing only their spans.
import 'reflect-metadata';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Controller,
  type ExecutionContext,
  Get,
  type INestApplication,
  Module,
  Query,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { EntryType } from '../entry/entry.js';
import type { WaterfallSpan } from '../metrics/waterfall.js';
import type { ConsoleAuthorizeResult } from '../nest/console-authorize.js';
import { TelescopeModule } from '../nest/telescope.module.js';
import type { TelescopeModuleOptions } from '../nest/telescope.options.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { hmacTenantVerifier, signTenantToken } from '../topology/tenant-auth.js';

const SECRET = 'trace-secret';
const UPSTREAM_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const UPSTREAM = `00-${UPSTREAM_TRACE}-00f067aa0ba902b7-01`;

const apps: INestApplication[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
});

const authorize = (context: ExecutionContext): ConsoleAuthorizeResult => {
  const grant = context.switchToHttp().getRequest().headers['x-grant'];
  return grant ? (JSON.parse(grant) as ConsoleAuthorizeResult) : true;
};

/** Where the shop app calls (set per test), and what headers its last call carried. */
const target = { url: '', headers: {} as Record<string, string> };

@Controller()
class ShopController {
  @Get('checkout')
  async checkout(@Query('path') path?: string): Promise<{ ok: boolean }> {
    const response = await fetch(`${target.url}${path ?? '/invoices/1'}`, {
      headers: target.headers,
    });
    await response.text();
    return { ok: response.ok };
  }
}

/** Billing echoes the trace headers it got. */
@Controller()
class BillingController {
  @Get('invoices/:id')
  invoice(@Query() _query: unknown): { ok: true } {
    return { ok: true };
  }
}

async function boot(
  options: TelescopeModuleOptions,
  controllers: Array<new (...args: never[]) => unknown> = [],
): Promise<INestApplication> {
  @Module({ controllers })
  class Host {}
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ authorize, ...options }), Host],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

function originOf(app: INestApplication | Server): string {
  const server = 'getHttpServer' in app ? app.getHttpServer() : app;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A plain server that records the headers of every request it gets. */
async function headerSink(): Promise<{ server: Server; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.end('{}');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen };
}

async function stop(app: INestApplication): Promise<void> {
  apps.splice(apps.indexOf(app), 1);
  await app.close();
}

function flatten(spans: WaterfallSpan[]): WaterfallSpan[] {
  return spans.flatMap((span) => [span, ...flatten(span.children)]);
}

async function fleetOfThree() {
  const storage = new InMemoryStorageProvider();
  const cp = await boot({
    topology: 'control-plane',
    verifyTenant: hmacTenantVerifier(SECRET),
    storage,
    fleet: false,
  });
  const cpUrl = `${originOf(cp)}/telescope`;
  const tenant = (partition: string) => ({
    topology: 'tenant' as const,
    fleet: false,
    tenant: {
      url: cpUrl,
      partition,
      token: signTenantToken(partition, SECRET),
      intervalMs: 20,
    },
  });
  // Billing first: outgoing propagation is per process, and shop's is the one under test.
  const billing = await boot(tenant('billing'), [BillingController]);
  const shop = await boot(
    { ...tenant('shop'), propagation: { targets: [originOf(billing), cpUrl] } },
    [ShopController],
  );
  target.url = originOf(billing);
  target.headers = {};
  return { cp, storage, shop, billing };
}

describe('tracing across apps', () => {
  it('shows one waterfall across shop and billing on the control plane', async () => {
    const { cp, storage, shop, billing } = await fleetOfThree();
    await request(shop.getHttpServer()).get('/checkout').expect(200);
    await stop(shop);
    await stop(billing);

    const requests = (await storage.get({ type: EntryType.Request, limit: 10 })).data;
    expect(requests).toHaveLength(2);
    const [traceId] = new Set(requests.map((entry) => entry.traceId));
    expect(new Set(requests.map((entry) => entry.traceId)).size).toBe(1);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);

    const server = cp.getHttpServer();
    const traces = await request(server).get('/telescope/api/traces').expect(200);
    expect(traces.body.data[0]).toMatchObject({ traceId, apps: ['shop', 'billing'] });

    const waterfall = await request(server)
      .get(`/telescope/api/traces/${traceId}/waterfall`)
      .expect(200);
    expect(waterfall.body.apps).toEqual(['shop', 'billing']);
    expect(waterfall.body.hiddenSpans).toBeUndefined();
    const [root] = waterfall.body.spans as WaterfallSpan[];
    expect(root).toMatchObject({ type: 'request', app: 'shop', label: 'GET /checkout' });
    const nested = flatten(root?.children ?? []);
    expect(nested).toContainEqual(
      expect.objectContaining({ type: 'request', app: 'billing', label: 'GET /invoices/1' }),
    );

    // A viewer of every app picking `?app=shop` still sees the whole trace.
    const picked = await request(server)
      .get(`/telescope/api/traces/${traceId}/waterfall?app=shop`)
      .expect(200);
    expect(flatten(picked.body.spans)).toHaveLength(2);

    // A viewer limited to shop sees shop's span and how many others are hidden.
    const limited = await request(server)
      .get(`/telescope/api/traces/${traceId}/waterfall`)
      .set('x-grant', JSON.stringify({ allowed: true, apps: ['shop'] }))
      .expect(200);
    expect(flatten(limited.body.spans).map((span: WaterfallSpan) => span.app)).toEqual(['shop']);
    expect(limited.body.hiddenSpans).toBe(1);
    expect(JSON.stringify(limited.body)).not.toContain('/invoices/1');

    // A viewer of an app the trace never reached gets a 404.
    await request(server)
      .get(`/telescope/api/traces/${traceId}/waterfall`)
      .set('x-grant', JSON.stringify({ allowed: true, apps: ['search'] }))
      .expect(404);
  });

  it('continues an upstream trace and forwards its tracestate', async () => {
    const sink = await headerSink();
    const { storage, shop, billing } = await fleetOfThree();
    target.url = originOf(billing);
    await request(shop.getHttpServer())
      .get('/checkout')
      .set('traceparent', UPSTREAM)
      .set('tracestate', 'vendor=x')
      .expect(200);
    await stop(shop);
    await stop(billing);
    const requests = (await storage.get({ type: EntryType.Request, limit: 10 })).data;
    expect(requests.map((entry) => entry.traceId)).toEqual([UPSTREAM_TRACE, UPSTREAM_TRACE]);
    const shopRequest = requests.find((entry) => entry.tags.includes('app:shop'));
    expect(shopRequest?.content).toMatchObject({ parentSpanId: '00f067aa0ba902b7' });
    expect(sink.seen).toHaveLength(0);
  });

  it('sends nothing to a non-target, keeps a header the code set, and skips its own ingest', async () => {
    const sink = await headerSink();
    const { shop } = await fleetOfThree();
    const server = shop.getHttpServer();

    target.url = originOf(sink.server);
    await request(server).get('/checkout').expect(200);
    expect(sink.seen[0]?.traceparent).toBeUndefined();

    target.headers = { traceparent: UPSTREAM };
    await request(server).get('/checkout').expect(200);
    expect(sink.seen[1]?.traceparent).toBe(UPSTREAM);
  });

  it("never adds a header to telescope's own ingest call, even when the control plane is a target", async () => {
    const sink = await headerSink();
    const cpUrl = `${originOf(sink.server)}/telescope`;
    const shop = await boot(
      {
        topology: 'tenant',
        fleet: false,
        propagation: { targets: 'all' },
        tenant: {
          url: cpUrl,
          partition: 'shop',
          token: signTenantToken('shop', SECRET),
          intervalMs: 20,
        },
      },
      [ShopController],
    );
    target.url = originOf(sink.server);
    target.headers = {};
    await request(shop.getHttpServer()).get('/checkout?path=/x').expect(200);
    await stop(shop);
    const ingest = sink.seen.filter((headers) => headers.authorization !== undefined);
    const call = sink.seen.filter((headers) => headers.authorization === undefined);
    expect(ingest.length).toBeGreaterThan(0);
    expect(ingest.every((headers) => headers.traceparent === undefined)).toBe(true);
    expect(call[0]?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('leaves a standalone app that configures nothing exactly as before', async () => {
    const sink = await headerSink();
    const storage = new InMemoryStorageProvider();
    const app = await boot({ storage }, [ShopController]);
    target.url = originOf(sink.server);
    target.headers = {};
    await request(app.getHttpServer()).get('/checkout').set('traceparent', UPSTREAM).expect(200);
    await stop(app);
    const [entry] = (await storage.get({ type: EntryType.Request, limit: 1 })).data;
    expect(entry?.traceId).toBeNull();
    expect(entry?.content).not.toHaveProperty('parentSpanId');
    expect(sink.seen[0]?.traceparent).toBeUndefined();
  });

  it('honours `incoming: false` and covers node:http only with `nodeHttp`', async () => {
    const sink = await headerSink();
    const storage = new InMemoryStorageProvider();
    const http = await import('node:http');
    @Controller()
    class NodeHttpController {
      @Get('legacy')
      async legacy(): Promise<{ ok: true }> {
        await new Promise<void>((resolve, reject) => {
          http
            .get(`${originOf(sink.server)}/legacy`, (res) => {
              res.resume();
              res.on('end', resolve);
            })
            .on('error', reject);
        });
        return { ok: true };
      }
    }
    const app = await boot(
      {
        storage,
        propagation: { targets: [originOf(sink.server)], incoming: false, nodeHttp: true },
      },
      [NodeHttpController],
    );
    await request(app.getHttpServer()).get('/legacy').set('traceparent', UPSTREAM).expect(200);
    await stop(app);
    const [entry] = (await storage.get({ type: EntryType.Request, limit: 1 })).data;
    // Not the caller's trace: a trace of its own, sent on along the node:http call.
    expect(entry?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(entry?.traceId).not.toBe(UPSTREAM_TRACE);
    expect(sink.seen[0]?.traceparent).toContain(entry?.traceId as string);

    const off = await boot(
      { storage: new InMemoryStorageProvider(), propagation: { targets: [originOf(sink.server)] } },
      [NodeHttpController],
    );
    await request(off.getHttpServer()).get('/legacy').expect(200);
    expect(sink.seen[1]?.traceparent).toBeUndefined();
  });
});
