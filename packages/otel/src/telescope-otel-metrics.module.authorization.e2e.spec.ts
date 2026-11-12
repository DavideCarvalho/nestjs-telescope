// E2E against the REAL `@nestjs/authorization` (deny-by-default global guard).
import 'reflect-metadata';
import { authorizeByToken } from '@dudousxd/nestjs-telescope';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import {
  Controller,
  type DynamicModule,
  Get,
  type INestApplication,
  Inject,
  Logger,
  type Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TELESCOPE_OTEL_EXPORTER, TelescopeOtelMetricsController } from './metrics.controller.js';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';
import { TelescopeOtelMetricsModule } from './telescope-otel-metrics.module.js';

type User = { id: string; scraper: boolean };

@Policy()
class MetricsPolicy {
  scrape(user: User | null): boolean {
    return user?.scraper === true;
  }
}

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(imports: DynamicModule[], controllers: Type[] = []): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports,
    controllers,
    providers: [MetricsPolicy],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.use(
    (req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => {
      const raw = req.headers['x-user'];
      if (raw) req.user = JSON.parse(raw);
      next();
    },
  );
  await app.init();
  return app;
}

function get(target: INestApplication, user?: User, url = '/metrics') {
  const req = request(target.getHttpServer()).get(url);
  return user ? req.set('x-user', JSON.stringify(user)) : req;
}

describe('TelescopeOtelMetricsModule under @nestjs/authorization', () => {
  it('(a) serves /metrics with the global guard on and no decorators', async () => {
    const exporter = new TelescopeOtelExporter();
    const target = await boot([
      AuthorizationModule.forRoot(),
      TelescopeOtelMetricsModule.forExporter(exporter),
    ]);
    await get(target).expect(200);
  });

  it('(b) enforces a Can() passed in decorators: guest 401, denied 403, allowed 200', async () => {
    const exporter = new TelescopeOtelExporter();
    const target = await boot([
      AuthorizationModule.forRoot(),
      TelescopeOtelMetricsModule.forExporter(exporter, {
        decorators: [Can(MetricsPolicy, 'scrape')],
      }),
    ]);
    await get(target).expect(401);
    await get(target, { id: 'u', scraper: false }).expect(403);
    await get(target, { id: 's', scraper: true }).expect(200);
  });

  it('(c) decorators from one registration do not leak into the next', async () => {
    const first = await boot([
      AuthorizationModule.forRoot(),
      TelescopeOtelMetricsModule.forExporter(new TelescopeOtelExporter(), {
        decorators: [Can(MetricsPolicy, 'scrape')],
      }),
    ]);
    await get(first, { id: 'u', scraper: false }).expect(403);
    await first.close();

    const second = await boot([
      AuthorizationModule.forRoot(),
      TelescopeOtelMetricsModule.forExporter(new TelescopeOtelExporter()),
    ]);
    await get(second, { id: 'u', scraper: false }).expect(200);
    expect(
      Reflect.getMetadata('authorization:can', TelescopeOtelMetricsController),
    ).toBeUndefined();
  });

  it('routes: false mounts nothing; developer-mounted controllers protected with @Can serve the scrape', async () => {
    // (1) Extend the exported controller under the developer's own mount.
    @Can(MetricsPolicy, 'scrape')
    @Controller('ops')
    class OpsMetrics extends TelescopeOtelMetricsController {}

    // (2) Or a plain controller of their own calling the exporter.
    @Can(MetricsPolicy, 'scrape')
    @Controller('internal')
    class InternalMetrics {
      constructor(
        @Inject(TELESCOPE_OTEL_EXPORTER) private readonly exporter: TelescopeOtelExporter,
      ) {}
      @Get('metrics')
      metrics(): string {
        return this.exporter.prometheus();
      }
    }

    const exporter = new TelescopeOtelExporter();
    expect(
      TelescopeOtelMetricsModule.forExporter(exporter, { routes: false }).controllers,
    ).toBeUndefined();
    const target = await boot(
      [
        AuthorizationModule.forRoot(),
        TelescopeOtelMetricsModule.forExporter(exporter, { routes: false }),
      ],
      [OpsMetrics, InternalMetrics],
    );
    await get(target, { id: 's', scraper: true }).expect(404);
    for (const url of ['/ops/metrics', '/internal/metrics']) {
      await get(target, undefined, url).expect(401);
      await get(target, { id: 'u', scraper: false }, url).expect(403);
      await get(target, { id: 's', scraper: true }, url).expect(200);
    }
  });
});

describe('TelescopeOtelMetricsModule authorize', () => {
  const previous = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = previous;
    vi.restoreAllMocks();
  });

  it('omitted: open outside production', async () => {
    process.env.NODE_ENV = 'development';
    const target = await boot([
      TelescopeOtelMetricsModule.forExporter(new TelescopeOtelExporter()),
    ]);
    await get(target).expect(200);
  });

  it('omitted: boots in production, answers 403 and warns once', async () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const target = await boot([
      AuthorizationModule.forRoot(),
      TelescopeOtelMetricsModule.forExporter(new TelescopeOtelExporter(), {
        decorators: [Can(MetricsPolicy, 'scrape')],
      }),
    ]);
    await get(target, { id: 's', scraper: true }).expect(403, { error: 'forbidden' });
    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('console has no `authorize` configured'),
    );
    expect(warnings.map(([message]) => message)).toEqual([
      '[@dudousxd/nestjs-telescope-otel] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in TelescopeOtelMetricsModule.forExporter().',
    ]);
  });

  it('authorizeByToken: a Prometheus Bearer token scrapes in production', async () => {
    process.env.NODE_ENV = 'production';
    const target = await boot([
      TelescopeOtelMetricsModule.forExporter(new TelescopeOtelExporter(), {
        authorize: authorizeByToken({ token: 'scrape-key' }),
      }),
    ]);
    await get(target).expect(401, { error: 'unauthenticated' });
    await get(target).set('Authorization', 'Bearer wrong').expect(401);
    await get(target).set('Authorization', 'Bearer scrape-key').expect(200);
  });

  it('the policy form runs @nestjs/authorization', async () => {
    const target = await boot([
      AuthorizationModule.forRoot(),
      TelescopeOtelMetricsModule.forExporter(new TelescopeOtelExporter(), {
        authorize: { policy: MetricsPolicy, ability: 'scrape' },
      }),
    ]);
    await get(target).expect(401);
    await get(target, { id: 'u', scraper: false }).expect(403);
    await get(target, { id: 's', scraper: true }).expect(200);
  });

  it('routes: false boots in production and mounts nothing', async () => {
    process.env.NODE_ENV = 'production';
    const selfMounted = await boot([
      TelescopeOtelMetricsModule.forExporter(new TelescopeOtelExporter(), { routes: false }),
    ]);
    await request(selfMounted.getHttpServer()).get('/metrics').expect(404);
  });
});
