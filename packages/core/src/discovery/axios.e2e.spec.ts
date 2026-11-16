// Service discovery through `@nestjs/axios`'s HttpService: `http.get('http://billing/…')` reaches
// the app with the same rules as fetch, from every HttpService in the app and a handed-over
// instance; the trace header follows the real origin; strict names reject with DiscoveryError; and
// the fetch / nodeHttp rewrites never resolve a request a second time.
import 'reflect-metadata';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpModule, HttpService } from '@nestjs/axios';
import { Controller, Get, type INestApplication, Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelescopeModule } from '../nest/telescope.module.js';
import type { TelescopeModuleOptions } from '../nest/telescope.options.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { ServiceDirectory } from './directory.js';
import { runResolvedByDiscovery } from './handled.js';
import { discoveryInterceptor } from './rewrite.js';

const seen: Array<{ url: string | undefined; headers: IncomingHttpHeaders }> = [];
let sink: Server;
let sinkOrigin = '';
const apps: INestApplication[] = [];

beforeEach(async () => {
  seen.length = 0;
  sink = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
  sinkOrigin = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  sink.closeAllConnections();
  await new Promise((r) => sink.close(r));
});

@Injectable()
class BillingClient {
  constructor(@Inject(HttpService) readonly http: HttpService) {}
}
@Module({
  imports: [HttpModule.register({ baseURL: 'http://billing/v2' })],
  providers: [BillingClient],
  exports: [BillingClient],
})
class BillingModule {}

const bare = axios.create();

@Controller()
class CallController {
  constructor(
    @Inject(HttpService) private readonly http: HttpService,
    @Inject(BillingClient) private readonly billing: BillingClient,
  ) {}

  @Get('default')
  async viaDefault(): Promise<unknown> {
    return (await firstValueFrom(this.http.get('http://billing/invoices?id=1'))).data;
  }

  @Get('registered')
  async viaRegistered(): Promise<unknown> {
    return (await firstValueFrom(this.billing.http.get('invoices/2'))).data;
  }

  @Get('bare')
  async viaBare(): Promise<unknown> {
    return (await bare.get('http://billing/bare')).data;
  }

  @Get('typo')
  async typo(): Promise<unknown> {
    try {
      await firstValueFrom(this.http.get('http://billng/x'));
      return { error: null };
    } catch (error) {
      return { error: `${(error as Error).name}: ${(error as Error).message}` };
    }
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

describe('service discovery through @nestjs/axios HttpService', () => {
  it('resolves app names from every HttpService and a handed-over instance, base path kept', async () => {
    const app = await boot({
      storage: new InMemoryStorageProvider(),
      discovery: { apps: { billing: `${sinkOrigin}/base` }, axios: bare },
      propagation: { targets: [sinkOrigin], axios: bare },
    });
    const server = app.getHttpServer();
    await request(server).get('/default').expect(200);
    await request(server).get('/registered').expect(200);
    await request(server).get('/bare').expect(200);
    expect(seen.map((call) => call.url)).toEqual([
      '/base/invoices?id=1',
      '/base/v2/invoices/2',
      '/base/bare',
    ]);
    // The trace header follows the real origin listed in the targets.
    for (const call of seen) {
      expect(call.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(call.headers.host).toBe(sinkOrigin.slice('http://'.length));
    }
  });

  it('rejects an unknown name with strict, and resolves once with nodeHttp on too', async () => {
    const app = await boot({
      storage: new InMemoryStorageProvider(),
      discovery: { apps: { billing: `${sinkOrigin}/base` }, strict: true, nodeHttp: true },
    });
    const server = app.getHttpServer();
    const typo = await request(server).get('/typo').expect(200);
    expect(typo.body.error).toMatch(/^DiscoveryError: telescope: app billng is not registered/);
    await request(server).get('/default').expect(200);
    expect(seen.map((call) => call.url)).toEqual(['/base/invoices?id=1']);
  });

  it('leaves HttpService alone with `axios: false`', async () => {
    const app = await boot({
      storage: new InMemoryStorageProvider(),
      discovery: { apps: { billing: `${sinkOrigin}/base` }, axios: false, strict: true },
    });
    const typo = await request(app.getHttpServer()).get('/typo').expect(200);
    expect(typo.body.error).not.toMatch(/DiscoveryError/);
  });
});

describe('a request axios already resolved', () => {
  it('is not rewritten again by the fetch interceptor', () => {
    const directory = new ServiceDirectory({ billing: 'http://gateway:8080/base' });
    const seenOrigins: string[] = [];
    const dispatch = discoveryInterceptor(directory, { passthrough: new Set(), failFast: false })(
      (opts) => {
        seenOrigins.push(String(opts.origin));
        return true;
      },
    );
    dispatch({ origin: 'http://billing', path: '/x' }, {});
    runResolvedByDiscovery(() => dispatch({ origin: 'http://billing', path: '/x' }, {}));
    expect(seenOrigins).toEqual(['http://gateway:8080', 'http://billing']);
  });
});
