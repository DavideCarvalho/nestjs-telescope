// E2E against the REAL `@nestjs/authorization` (deny-by-default global guard).
import 'reflect-metadata';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import {
  Controller,
  type DynamicModule,
  Get,
  type INestApplication,
  Inject,
  type Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
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
  app = moduleRef.createNestApplication();
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

describe('TelescopeOtelMetricsModule production rule', () => {
  const previous = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = previous;
  });

  it('boots by default with no decorators: the scrape is outside the rule', async () => {
    process.env.NODE_ENV = 'production';
    const target = await boot([
      AuthorizationModule.forRoot(),
      TelescopeOtelMetricsModule.forExporter(new TelescopeOtelExporter()),
    ]);
    await get(target).expect(200);
    expect(() =>
      TelescopeOtelMetricsModule.forExporter(new TelescopeOtelExporter(), {
        decorators: [],
        requireProtectionInProduction: false,
      }),
    ).not.toThrow();
  });

  it('requireProtectionInProduction: fails the boot with no decorators (an empty array counts as none)', () => {
    process.env.NODE_ENV = 'production';
    const exporter = new TelescopeOtelExporter();
    for (const decorators of [undefined, []]) {
      expect(() =>
        TelescopeOtelMetricsModule.forExporter(exporter, {
          requireProtectionInProduction: true,
          ...(decorators ? { decorators } : {}),
        }),
      ).toThrow(
        /TelescopeOtelMetricsModule: refusing to mount unprotected routes with NODE_ENV=production/,
      );
    }
  });

  it('requireProtectionInProduction: mounts open outside production', async () => {
    process.env.NODE_ENV = 'development';
    const target = await boot([
      TelescopeOtelMetricsModule.forExporter(new TelescopeOtelExporter(), {
        requireProtectionInProduction: true,
      }),
    ]);
    await get(target).expect(200);
  });

  it('enforces decorators in production, with or without requireProtectionInProduction', async () => {
    process.env.NODE_ENV = 'production';
    for (const requireProtectionInProduction of [undefined, true]) {
      const target = await boot([
        AuthorizationModule.forRoot(),
        TelescopeOtelMetricsModule.forExporter(new TelescopeOtelExporter(), {
          decorators: [Can(MetricsPolicy, 'scrape')],
          ...(requireProtectionInProduction ? { requireProtectionInProduction } : {}),
        }),
      ]);
      await get(target).expect(401);
      await get(target, { id: 'u', scraper: false }).expect(403);
      await get(target, { id: 's', scraper: true }).expect(200);
      await target.close();
      app = undefined;
    }
  });

  it('routes: false boots even with requireProtectionInProduction', async () => {
    process.env.NODE_ENV = 'production';
    const exporter = new TelescopeOtelExporter();
    const selfMounted = await boot([
      TelescopeOtelMetricsModule.forExporter(exporter, {
        routes: false,
        requireProtectionInProduction: true,
      }),
    ]);
    await request(selfMounted.getHttpServer()).get('/metrics').expect(404);
  });
});
