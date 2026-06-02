// packages/mikro-orm/src/mikro-orm-query.watcher.integration.spec.ts
//
// Integration: real MikroORM sqlite ORM + real TelescopeModule.
// Validates that queries are recorded and correlated to the request batch
// via the HOST-WIRED loggerFactory path.
//
// MikroORM v7 caches its logger in a private #logger field at Configuration
// constructor time. Runtime config.set('loggerFactory') does NOT update the
// cached instance, so zero-config runtime-wrap is impossible on v7. Instead,
// the host wires telescopeMikroOrmLogger into loggerFactory before the ORM is
// created — that is the validated, working path.
//
// Note: Vitest uses esbuild to transform files, which does NOT emit decorator
// metadata. NestJS constructor injection relies on that metadata. To avoid this
// constraint, the controller uses explicit @Inject() with a string token for
// the EntityManager, bypassing reflection-based DI resolution.
//
import 'reflect-metadata';
import type { Entry } from '@dudousxd/nestjs-telescope';
import { TelescopeModule, TelescopeService, detectNPlusOne } from '@dudousxd/nestjs-telescope';
import { EntityManager, EntitySchema, MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Controller, Get, type INestApplication, Inject, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MikroOrmQueryWatcher } from './mikro-orm-query.watcher.js';
import { telescopeMikroOrmLogger } from './telescope-mikro-orm.logger.js';

// ---------------------------------------------------------------------------
// Entity defined via EntitySchema (no decorator transpilation needed)
// ---------------------------------------------------------------------------
interface AuthorShape {
  id: number;
  name: string;
}

const Author = new EntitySchema<AuthorShape>({
  name: 'Author',
  tableName: 'author',
  properties: {
    id: { type: 'integer', primary: true },
    name: { type: 'string' },
  },
});

// ---------------------------------------------------------------------------
// Controller — uses @Inject(EntityManager) to avoid needing emitDecoratorMetadata
// ---------------------------------------------------------------------------
@Controller('authors')
class AuthorController {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  @Get()
  async findAll(): Promise<AuthorShape[]> {
    return this.em.fork().find<AuthorShape>(Author, {});
  }

  @Get('repeated')
  async repeated(): Promise<AuthorShape[]> {
    // Use a fresh fork() per iteration so the identity map is empty each time,
    // forcing a real DB round-trip and a new SQL query for each call.
    const results: AuthorShape[] = [];
    for (let i = 0; i < 5; i++) {
      const em = this.em.fork();
      const found = await em.findOne<AuthorShape>(Author, { id: 1 } as never);
      if (found) results.push(found);
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Integration test suite
// ---------------------------------------------------------------------------
describe('MikroOrmQueryWatcher integration (host-wired loggerFactory)', () => {
  let app: INestApplication;
  let orm: MikroORM;

  beforeAll(async () => {
    // Two-phase bootstrap: MikroORM needs loggerFactory at construction, but we
    // want queries to route to TelescopeService.record. Use a lazy closure that
    // reads the service after the module is compiled.
    let telescopeService: TelescopeService | null = null;
    const lazyRecord = (input: Parameters<TelescopeService['record']>[0]): void => {
      telescopeService?.record(input);
    };

    @Module({
      imports: [
        TelescopeModule.forRoot({
          authorizer: () => true,
          watchers: [new MikroOrmQueryWatcher()],
        }),
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Author],
          debug: ['query'],
          loggerFactory: telescopeMikroOrmLogger(lazyRecord, { slowMs: 10000 }),
          allowGlobalContext: true,
        }),
        MikroOrmModule.forFeature([Author]),
      ],
      controllers: [AuthorController],
    })
    class AppModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    // Resolve the service AFTER init so the lazy closure works.
    telescopeService = app.get(TelescopeService);

    // Create schema + seed.
    orm = app.get(MikroORM);
    await orm.schema.drop({ dropMigrationsTable: false });
    await orm.schema.create();

    const em = orm.em.fork();
    em.create<AuthorShape>(Author, { id: 1, name: 'Ada Lovelace' });
    await em.flush();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('records a query entry and correlates it to the request batch', async () => {
    // Hit the route via HTTP so the request middleware opens an ALS batch.
    const authorsRes = await request(app.getHttpServer()).get('/authors');
    expect(authorsRes.status).toBe(200);

    // Flush so buffered entries reach storage.
    await app.get(TelescopeService).flush();

    const res = await request(app.getHttpServer()).get('/telescope/api/entries').expect(200);

    const entries: Entry[] = (res.body as { data: Entry[] }).data;

    // 1. At least one query entry must exist.
    const queryEntries = entries.filter((e) => e.type === 'query');
    expect(queryEntries.length).toBeGreaterThan(0);

    // 2. Content must contain a real SQL string.
    const firstQuery = queryEntries[0]!;
    const sql = (firstQuery.content as { sql: string }).sql;
    expect(typeof sql).toBe('string');
    expect(sql.length).toBeGreaterThan(0);

    // 3. Query must be correlated to its request batch.
    const requestEntry = entries.find((e) => e.type === 'request');
    expect(requestEntry).toBeDefined();
    expect(firstQuery.batchId).toBe(requestEntry!.batchId);
  });

  it('detects N+1 when the same query template runs N times in one batch', async () => {
    await app.get(TelescopeService).flush();

    // Hit the route that runs 5 identical findOne queries.
    const repeatedRes = await request(app.getHttpServer()).get('/authors/repeated');
    expect(repeatedRes.status).toBe(200);
    await app.get(TelescopeService).flush();

    const res = await request(app.getHttpServer()).get('/telescope/api/entries').expect(200);

    const allEntries: Entry[] = (res.body as { data: Entry[] }).data;

    // The 5 repeated queries must correlate to the /authors/repeated REQUEST —
    // same batchId. This proves query→request correlation, not just "some batch".
    const repeatedRequest = allEntries.find(
      (e) =>
        e.type === 'request' &&
        typeof (e.content as { uri?: unknown }).uri === 'string' &&
        (e.content as { uri: string }).uri.includes('repeated'),
    );
    expect(repeatedRequest).toBeDefined();

    const batchEntries = allEntries.filter((e) => e.batchId === repeatedRequest!.batchId);
    const correlatedQueries = batchEntries.filter((e) => e.type === 'query');
    expect(correlatedQueries.length).toBeGreaterThanOrEqual(5);

    // The N+1 detector flags the repeated template within that request's batch.
    const insights = detectNPlusOne(batchEntries, 5);
    expect(insights.length).toBeGreaterThan(0);
    expect(insights[0]!.count).toBeGreaterThanOrEqual(5);
  });
});
