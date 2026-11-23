// packages/drizzle/src/telescope-drizzle.logger.integration.spec.ts
//
// Real Drizzle on PostgreSQL inside a real TelescopeModule app: the logger's query entries join the
// request batch that ran them, so the N+1 detector sees a loop of identical queries, and the
// provider, storing into the same database, records none of its own statements.
//
// Vitest's esbuild transform emits no decorator metadata, so the controller injects the database
// with an explicit token.
import 'reflect-metadata';
import type { Entry } from '@dudousxd/nestjs-telescope';
import { TelescopeModule, TelescopeService, detectNPlusOne } from '@dudousxd/nestjs-telescope';
import { Controller, Get, type INestApplication, Inject, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres } from '../test/postgres.js';
import { DrizzleStorageProvider } from './drizzle-storage.provider.js';
import { telescopeDrizzleLogger } from './telescope-drizzle.logger.js';

const postgres = await startPostgres();

const authors = pgTable('author', { id: integer('id').primaryKey(), name: text('name').notNull() });
const DB = Symbol('DB');

@Controller('authors')
class AuthorController {
  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}

  @Get()
  async findAll() {
    return this.db.select().from(authors);
  }

  @Get('repeated')
  async repeated() {
    const found = [];
    for (let i = 0; i < 5; i++) {
      found.push(...(await this.db.select().from(authors).where(eq(authors.id, 1))));
    }
    return found;
  }
}

describe.skipIf(postgres.skipReason !== null)('telescopeDrizzleLogger in a Nest app', () => {
  let app: INestApplication;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: postgres.url, max: 4 });
    await pool.query('create table author (id integer primary key, name text not null)');
    await pool.query(`insert into author values (1, 'Ada Lovelace')`);
    // The host's own Drizzle, with the Telescope logger; it resolves the record sink per call.
    const db = drizzle({ client: pool, logger: telescopeDrizzleLogger() });

    @Module({
      imports: [TelescopeModule.forRoot({ storage: new DrizzleStorageProvider(db) })],
      controllers: [AuthorController],
      providers: [{ provide: DB, useValue: db }],
    })
    class AppModule {}

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await postgres.container?.stop();
  });

  const entries = async (): Promise<Entry[]> => {
    await app.get(TelescopeService).flush();
    const res = await request(app.getHttpServer())
      .get('/telescope/api/entries?first=100')
      .expect(200);
    return (res.body as { data: Entry[] }).data;
  };

  it('records the query and correlates it to the request batch', async () => {
    await request(app.getHttpServer()).get('/authors').expect(200);
    const all = await entries();
    const req = all.find(
      (e) => e.type === 'request' && (e.content as { uri: string }).uri === '/authors',
    );
    expect(req).toBeDefined();
    const queries = all.filter((e) => e.type === 'query' && e.batchId === req?.batchId);
    expect(queries).toHaveLength(1);
    expect((queries[0]?.content as { sql: string }).sql).toMatch(/from "author"/);
  });

  it('lets the N+1 detector see a loop of identical queries in one request', async () => {
    await request(app.getHttpServer()).get('/authors/repeated').expect(200);
    const all = await entries();
    const req = all.find(
      (e) => e.type === 'request' && (e.content as { uri: string }).uri === '/authors/repeated',
    );
    const batch = all.filter((e) => e.batchId === req?.batchId);
    expect(batch.filter((e) => e.type === 'query')).toHaveLength(5);
    expect(detectNPlusOne(batch, 5)[0]?.count).toBe(5);
  });

  it('never records the storage provider’s own statements', async () => {
    const all = await entries();
    const own = all.filter(
      (e) => e.type === 'query' && /telescope_/.test((e.content as { sql: string }).sql),
    );
    expect(own).toEqual([]);
  });
});
