// packages/drizzle/src/drizzle-storage.provider.integration.spec.ts
//
// What the conformance suite does not cover, on real PostgreSQL: boot (fresh database, the
// fingerprint gate, additive heal of an older table, drizzle-kit parity, the `schema` option),
// connection ownership (borrowed vs dedicated pools, no self-capture through the host's logger),
// batched flushes, concurrency (leases, rollups) and the opt-in Overview indexes.
import type { Entry, RecordInput } from '@dudousxd/nestjs-telescope';
import { HISTOGRAM_BUCKET_COUNT } from '@dudousxd/nestjs-telescope';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { freshDatabase, startPostgres } from '../test/postgres.js';
import { bootFingerprint } from './boot-ddl.js';
import { DrizzleStorageProvider } from './drizzle-storage.provider.js';
import { OVERVIEW_INDEX_NAMES } from './overview-indexes.js';
import { telescopeManagedTables, telescopeTables } from './schema.js';
import { telescopeDrizzleLogger } from './telescope-drizzle.logger.js';

const postgres = await startPostgres();
const docker = postgres.skipReason === null;

let counter = 0;
function entry(overrides: Partial<Entry> = {}): Entry {
  counter += 1;
  return {
    id: `e-${counter}-${Math.random().toString(36).slice(2, 8)}`,
    batchId: 'b1',
    type: 'request',
    familyHash: null,
    content: { uri: `/${counter}` },
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i1',
    traceId: null,
    spanId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const histogram = (cell: number, value: number): number[] => {
  const cells = new Array<number>(HISTOGRAM_BUCKET_COUNT).fill(0);
  cells[cell] = value;
  return cells;
};

let databases = 0;
/** A provider-free pool on a brand-new database. */
async function newDatabase(): Promise<{ url: string; pool: pg.Pool }> {
  databases += 1;
  const url = await freshDatabase(postgres.url, `t${databases}_${process.pid}`);
  return { url, pool: new pg.Pool({ connectionString: url, max: 4 }) };
}

const tablesIn = async (pool: pg.Pool, schema = 'public'): Promise<string[]> =>
  (
    await pool.query<{ table_name: string }>(
      'select table_name from information_schema.tables where table_schema = $1 order by table_name',
      [schema],
    )
  ).rows.map((row) => row.table_name);

afterAll(async () => {
  await postgres.container?.stop();
});

/** The SQL `drizzle-kit generate` writes for the exported tables, against an empty database. */
async function drizzleKitSql(schema?: string): Promise<string[]> {
  const { entries, rollups, leases, schemaMeta, namespace } = telescopeTables(schema);
  const empty = generateDrizzleJson({});
  const current = generateDrizzleJson({
    entries,
    rollups,
    leases,
    schemaMeta,
    ...(namespace !== undefined ? { namespace } : {}),
  });
  return generateMigration(empty, current);
}

/** Every column, index and constraint of the tables in `schema`, in a comparable form. */
async function catalog(pool: pg.Pool, schema: string) {
  const columns = await pool.query(
    `select table_name, column_name, data_type, character_maximum_length, datetime_precision,
            is_nullable, column_default
       from information_schema.columns where table_schema = $1
      order by table_name, column_name`,
    [schema],
  );
  const indexes = await pool.query(
    `select tablename, indexname, regexp_replace(indexdef, ' ON .* USING ', ' USING ') as def
       from pg_indexes where schemaname = $1 order by indexname`,
    [schema],
  );
  const constraints = await pool.query(
    `select conrelid::regclass::text as table_name, conname, contype, pg_get_constraintdef(oid) as def
       from pg_constraint where connamespace = $1::regnamespace order by conname`,
    [schema],
  );
  return { columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows };
}

describe.skipIf(!docker)('DrizzleStorageProvider on PostgreSQL', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });
  const track = <T extends { close(): Promise<void> } | pg.Pool>(resource: T): T => {
    cleanup.push(async () => {
      if (resource instanceof pg.Pool) await resource.end();
      else await resource.close();
    });
    return resource;
  };

  describe('boot', () => {
    it('creates every managed table on a fresh database, and nothing else', async () => {
      const { url, pool } = await newDatabase();
      track(pool);
      const provider = track(new DrizzleStorageProvider({ connectionString: url }));
      await provider.init();
      expect(await tablesIn(pool)).toEqual([...telescopeManagedTables()].sort());

      await provider.store([entry({ id: 'fresh' })]);
      expect((await provider.get({})).data.map((e) => e.id)).toEqual(['fresh']);
    });

    it('records the fingerprint, and a second boot skips the DDL entirely', async () => {
      const { pool } = await newDatabase();
      track(pool);
      await track(new DrizzleStorageProvider(pool)).init();
      const marker = await pool.query('select id, fingerprint from telescope_schema_meta');
      expect(marker.rows).toEqual([{ id: 'drizzle', fingerprint: bootFingerprint(undefined) }]);

      // A gated boot reads the marker and nothing else: no lock, no DDL.
      const query = vi.spyOn(pg.Client.prototype, 'query');
      const second = new DrizzleStorageProvider(pool);
      try {
        await second.init();
        const texts = query.mock.calls.map((call) =>
          typeof call[0] === 'string' ? call[0] : (call[0] as { text: string }).text,
        );
        expect(texts).toHaveLength(1);
        expect(texts[0]).toMatch(/^select "fingerprint" from "telescope_schema_meta"/);
      } finally {
        query.mockRestore();
        await second.close();
      }
    });

    it('serializes concurrent first boots, which all come up', async () => {
      const { url, pool } = await newDatabase();
      track(pool);
      const providers = Array.from({ length: 4 }, () =>
        track(new DrizzleStorageProvider({ connectionString: url })),
      );
      await Promise.all(providers.map((provider) => provider.init()));
      expect(await tablesIn(pool)).toEqual([...telescopeManagedTables()].sort());
    });

    it('heals an older table additively: adds the missing columns and keeps its rows', async () => {
      const { pool } = await newDatabase();
      track(pool);
      // A `telescope_entries` from before durations, families and traces, holding a row.
      await pool.query(`create table telescope_entries (
        id varchar(64) primary key, batch_id varchar(64) not null, type varchar(32) not null,
        content jsonb not null, tags jsonb not null, tags_text text not null,
        sequence integer not null, origin varchar(16) not null, instance_id varchar(128) not null,
        created_at timestamptz(3) not null)`);
      await pool.query(`insert into telescope_entries values
        ('old', 'b0', 'request', '{"uri":"/old"}', '["legacy"]', ' legacy ', 0, 'http', 'i0', now())`);
      await pool.query(`create table telescope_rollups (metric varchar(64) not null,
        bucket_start bigint not null, count bigint not null, sum bigint not null, max bigint not null,
        primary key (metric, bucket_start))`);

      const provider = track(new DrizzleStorageProvider(pool));
      await provider.init();

      const old = await provider.find('old');
      expect(old).toMatchObject({ id: 'old', tags: ['legacy'], durationMs: null, traceId: null });
      await provider.store([entry({ id: 'new', durationMs: 4, traceId: 't', spanId: 's' })]);
      expect(await provider.find('new')).toMatchObject({
        durationMs: 4,
        traceId: 't',
        spanId: 's',
      });
      await provider.recordRollups([
        { metric: 'm', bucketStart: 0, count: 1, sum: 2, max: 2, histogram: histogram(1, 1) },
      ]);
      expect((await provider.queryRollups(['m'], 0, 0))[0]?.histogram[1]).toBe(1);
    });

    it('never drops an index a host added, nor touches the host’s own tables', async () => {
      const { pool } = await newDatabase();
      track(pool);
      await pool.query('create table host_users (id serial primary key, name text)');
      await pool.query(`insert into host_users (name) values ('ada')`);
      const provider = track(new DrizzleStorageProvider(pool));
      await provider.init();
      await pool.query('create index host_added_idx on telescope_entries (instance_id)');
      // Force the DDL to run again, as a release that changed it would.
      await pool.query(`update telescope_schema_meta set fingerprint = 'stale'`);
      const again = new DrizzleStorageProvider(pool);
      await again.init();
      await again.close();

      const indexes = await pool.query<{ indexname: string }>(
        `select indexname from pg_indexes where tablename = 'telescope_entries'`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toContain('host_added_idx');
      expect((await pool.query('select name from host_users')).rows).toEqual([{ name: 'ada' }]);
    });

    it('creates exactly what drizzle-kit generates from the exported schema', async () => {
      // One database built by the boot DDL, one by drizzle-kit's migration SQL for `schema.ts`:
      // their catalogs must match column for column, index for index, constraint for constraint.
      const booted = await newDatabase();
      const generated = await newDatabase();
      track(booted.pool);
      track(generated.pool);
      await track(new DrizzleStorageProvider(booted.pool)).init();
      for (const statement of await drizzleKitSql()) await generated.pool.query(statement);
      expect(await catalog(booted.pool, 'public')).toEqual(await catalog(generated.pool, 'public'));
    });

    it('the same holds in a schema', async () => {
      const booted = await newDatabase();
      const generated = await newDatabase();
      track(booted.pool);
      track(generated.pool);
      await track(new DrizzleStorageProvider(booted.pool, { schema: 'telescope_obs' })).init();
      for (const statement of await drizzleKitSql('telescope_obs')) {
        await generated.pool.query(statement);
      }
      expect(await catalog(booted.pool, 'telescope_obs')).toEqual(
        await catalog(generated.pool, 'telescope_obs'),
      );
    });

    it('with ensureSchema off, creates nothing', async () => {
      const { pool } = await newDatabase();
      track(pool);
      await track(new DrizzleStorageProvider(pool, { ensureSchema: false })).init();
      expect(await tablesIn(pool)).toEqual([]);
    });
  });

  describe('schema option', () => {
    it('puts every table, row and lease in the schema, none in public', async () => {
      const { pool } = await newDatabase();
      track(pool);
      const provider = track(new DrizzleStorageProvider(pool, { schema: 'telescope_obs' }));
      await provider.init();
      await provider.store([entry({ id: 'in-schema', tags: ['status:200'] })]);
      await provider.recordRollups([
        { metric: 'm', bucketStart: 0, count: 1, sum: 1, max: 1, histogram: histogram(0, 1) },
      ]);
      expect(await provider.tryAcquireLease('prune', 'pod-a', 60_000, Date.now())).toBe(true);

      expect(await tablesIn(pool)).toEqual([]);
      expect(await tablesIn(pool, 'telescope_obs')).toEqual([...telescopeManagedTables()].sort());
      expect(
        (await pool.query('select id from telescope_obs.telescope_entries')).rows.map((r) => r.id),
      ).toEqual(['in-schema']);
      expect(
        (await pool.query('select count(*)::int as n from telescope_obs.telescope_leases')).rows,
      ).toEqual([{ n: 1 }]);
    });

    it('two schemas in one database stay apart', async () => {
      const { pool } = await newDatabase();
      track(pool);
      const a = track(new DrizzleStorageProvider(pool, { schema: 'a' }));
      const b = track(new DrizzleStorageProvider(pool, { schema: 'b' }));
      await a.init();
      await b.init();
      await a.store([entry({ id: 'only-a' })]);
      expect((await b.get({})).data).toEqual([]);
      expect((await a.get({})).data.map((e) => e.id)).toEqual(['only-a']);
    });

    it('works on an existing schema without CREATE rights on the database', async () => {
      const { url, pool } = await newDatabase();
      track(pool);
      await pool.query(`create role limited login password 'limited'`);
      await pool.query('create schema obs authorization limited');
      // PUBLIC has no CREATE on a database by default, so this role cannot create a schema.
      const limitedUrl = new URL(url);
      limitedUrl.username = 'limited';
      limitedUrl.password = 'limited';
      const provider = track(
        new DrizzleStorageProvider({ connectionString: limitedUrl.toString() }, { schema: 'obs' }),
      );
      await provider.init();
      await provider.store([entry({ id: 'limited' })]);
      expect((await provider.get({})).data.map((e) => e.id)).toEqual(['limited']);
    });
  });

  describe('connections', () => {
    it("borrows the host's pool and never closes it", async () => {
      const { pool } = await newDatabase();
      track(pool);
      const provider = new DrizzleStorageProvider(drizzle({ client: pool }));
      await provider.init();
      await provider.close();
      expect(pool.ended).toBe(false);
      expect((await pool.query('select 1 as one')).rows).toEqual([{ one: 1 }]);
    });

    it('with dedicatedPool, opens its own pool from the host’s settings and closes it', async () => {
      const { pool } = await newDatabase();
      track(pool);
      const provider = new DrizzleStorageProvider(drizzle({ client: pool }), {
        dedicatedPool: { max: 2 },
      });
      await provider.init();
      await provider.store([entry({ id: 'dedicated' })]);
      // The host's pool never ran the store; the row is still in the host's database.
      expect(pool.totalCount).toBe(0);
      expect((await pool.query('select id from telescope_entries')).rows).toEqual([
        { id: 'dedicated' },
      ]);
      await provider.close();
    });

    it("opens its own pool when the host's client is a single pg.Client", async () => {
      const { url, pool } = await newDatabase();
      track(pool);
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      cleanup.push(() => client.end());
      const provider = track(new DrizzleStorageProvider(drizzle({ client })));
      await provider.init();
      await provider.store([entry({ id: 'via-client' })]);
      expect((await client.query('select id from telescope_entries')).rows).toEqual([
        { id: 'via-client' },
      ]);
    });

    it("never records its own statements through the host's Telescope logger", async () => {
      const { pool } = await newDatabase();
      track(pool);
      const recorded: RecordInput[] = [];
      const host = drizzle({
        client: pool,
        logger: telescopeDrizzleLogger((input) => recorded.push(input), { coverQueries: false }),
      });
      const provider = track(new DrizzleStorageProvider(host));
      await provider.init();
      await provider.store([entry()]);
      await provider.get({});
      await provider.prune(new Date());
      expect(recorded).toEqual([]);

      // The host's own queries still are.
      await host.execute('select 1');
      expect(recorded).toHaveLength(1);
    });
  });

  describe('writes', () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = (await newDatabase()).pool;
      await new DrizzleStorageProvider(pool).init();
    });
    afterAll(async () => {
      await pool.end();
    });

    it('stores a large flush in batchSize-row INSERTs inside one transaction', async () => {
      const provider = track(new DrizzleStorageProvider(pool, { batchSize: 2 }));
      await provider.init();
      await provider.clear();
      const statements: string[] = [];
      const query = vi.spyOn(pg.Client.prototype, 'query');
      try {
        await provider.store([entry(), entry(), entry(), entry(), entry()]);
        for (const call of query.mock.calls) {
          const text = typeof call[0] === 'string' ? call[0] : (call[0] as { text: string }).text;
          statements.push(text.split(' ')[0]?.toLowerCase() ?? '');
        }
      } finally {
        query.mockRestore();
      }
      expect(statements).toEqual(['begin', 'insert', 'insert', 'insert', 'commit']);
      expect((await provider.get({})).data).toHaveLength(5);
    });

    it('a flush whose later chunk fails stores nothing, so the retry stores every entry once', async () => {
      const provider = track(new DrizzleStorageProvider(pool, { batchSize: 2 }));
      await provider.init();
      await provider.clear();
      const flush = [entry(), entry(), entry()];
      const duplicate = { ...flush[0], sequence: 9 } as Entry;
      await expect(provider.store([...flush, duplicate])).rejects.toThrow();
      expect((await provider.get({})).data).toEqual([]);
      await provider.store(flush);
      expect((await provider.get({})).data).toHaveLength(3);
    });

    it('round-trips null content as JSON null', async () => {
      const provider = track(new DrizzleStorageProvider(pool));
      await provider.init();
      await provider.store([entry({ id: 'nothing', content: null })]);
      expect((await provider.find('nothing'))?.content).toBeNull();
      await provider.update('nothing', { content: { later: true } });
      expect((await provider.find('nothing'))?.content).toEqual({ later: true });
    });

    it('matches search against the content text, case-insensitively', async () => {
      const provider = track(new DrizzleStorageProvider(pool));
      await provider.init();
      await provider.clear();
      await provider.store([
        entry({ id: 'sql', content: { sql: 'SELECT * FROM Orders' } }),
        entry({ id: 'other', content: { sql: 'select 1' } }),
      ]);
      expect((await provider.get({ search: 'from orders' })).data.map((e) => e.id)).toEqual([
        'sql',
      ]);
    });

    it('pruneScopedBatch over all-types-but-some shares one limit across the types, oldest first', async () => {
      const provider = track(new DrizzleStorageProvider(pool));
      await provider.init();
      await provider.clear();
      const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
      await provider.store([
        entry({ id: 'q1', type: 'query', createdAt: at(1) }),
        entry({ id: 'q2', type: 'query', createdAt: at(2) }),
        entry({ id: 'r1', type: 'request', createdAt: at(3) }),
        entry({ id: 'd1', type: 'durable', createdAt: at(0) }),
      ]);
      expect(
        await provider.pruneScopedBatch({ before: at(10), excludeTypes: ['durable'], limit: 2 }),
      ).toEqual({ deleted: 2, hasMore: true });
      expect(
        await provider.pruneScopedBatch({ before: at(10), excludeTypes: ['durable'], limit: 2 }),
      ).toEqual({ deleted: 1, hasMore: false });
      expect((await provider.get({})).data.map((e) => e.id)).toEqual(['d1']);
    });
  });

  describe('concurrency', () => {
    let url: string;
    let pool: pg.Pool;
    beforeAll(async () => {
      ({ url, pool } = await newDatabase());
      await new DrizzleStorageProvider(pool).init();
    });
    afterAll(async () => {
      await pool.end();
    });

    it('grants a free lease to exactly one of many racing pods', async () => {
      const pods = Array.from({ length: 8 }, () =>
        track(new DrizzleStorageProvider({ connectionString: url })),
      );
      await Promise.all(pods.map((pod) => pod.init()));
      const now = Date.now();
      const granted = await Promise.all(
        pods.map((pod, index) => pod.tryAcquireLease('race', `pod-${index}`, 60_000, now)),
      );
      expect(granted.filter(Boolean)).toHaveLength(1);
    });

    it('never loses a rollup increment between pods writing the same buckets', async () => {
      const pods = Array.from({ length: 6 }, () =>
        track(new DrizzleStorageProvider({ connectionString: url })),
      );
      await Promise.all(pods.map((pod) => pod.init()));
      await Promise.all(
        pods.flatMap((pod) =>
          Array.from({ length: 5 }, (_, round) =>
            pod.recordRollups([
              {
                metric: 'c',
                bucketStart: 0,
                count: 1,
                sum: 2,
                max: round,
                histogram: histogram(3, 1),
              },
              {
                metric: 'c',
                bucketStart: 60_000,
                count: 1,
                sum: 1,
                max: 1,
                histogram: histogram(0, 1),
              },
            ]),
          ),
        ),
      );
      const buckets = await pods[0]!.queryRollups(['c'], 0, 60_000);
      const first = buckets.find((bucket) => bucket.bucketStart === 0);
      expect(first).toMatchObject({ count: 30, sum: 60, max: 4 });
      expect(first?.histogram[3]).toBe(30);
      expect(buckets.find((bucket) => bucket.bucketStart === 60_000)?.count).toBe(30);
    });
  });

  describe('Overview indexes', () => {
    it('creates the three indexes once, then nothing', async () => {
      const { pool } = await newDatabase();
      track(pool);
      const provider = track(new DrizzleStorageProvider(pool));
      expect((await provider.createOverviewIndexes()).sort()).toEqual(
        [...OVERVIEW_INDEX_NAMES].sort(),
      );
      expect(await provider.createOverviewIndexes()).toEqual([]);
      const options = await pool.query<{ reloptions: string[] }>(
        `select reloptions from pg_class where relname = 'telescope_entries'`,
      );
      expect(options.rows[0]?.reloptions).toContain('autovacuum_vacuum_scale_factor=0.02');
    });
  });
});
