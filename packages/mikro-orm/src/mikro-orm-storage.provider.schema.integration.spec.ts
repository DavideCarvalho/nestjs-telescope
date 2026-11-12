// packages/mikro-orm/src/mikro-orm-storage.provider.schema.integration.spec.ts
//
// The `schema` option on real PostgreSQL and MySQL (testcontainers; skipped without Docker):
// every table, the marker DDL, the rollup upsert and the leases land in the configured schema /
// database, nothing in the default one, and a second boot reuses them. SQLite refuses a schema.
import type { Entry } from '@dudousxd/nestjs-telescope';
import { HISTOGRAM_BUCKET_COUNT } from '@dudousxd/nestjs-telescope';
import { MikroORM } from '@mikro-orm/core';
import { MySqlDriver } from '@mikro-orm/mysql';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MikroOrmStorageProvider } from './mikro-orm-storage.provider.js';

const SCHEMA = 'telescope_obs';
const OWNED = [
  'telescope_entries',
  'telescope_leases',
  'telescope_rollups',
  'telescope_schema_meta',
];
const docker = process.env.TELESCOPE_SKIP_DOCKER !== '1';

function entry(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    batchId: 'b1',
    type: 'request',
    familyHash: null,
    content: { uri: `/${id}` },
    tags: ['status:200'],
    sequence: 0,
    durationMs: 3,
    origin: 'http',
    instanceId: 'i1',
    traceId: null,
    spanId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Exercises every statement family the provider issues: DDL, CRUD, tags, prune, rollups, leases. */
async function exercise(provider: MikroOrmStorageProvider): Promise<void> {
  await provider.store([
    entry('e1'),
    entry('e2', { createdAt: new Date(Date.now() - 86_400_000) }),
  ]);
  expect((await provider.find('e1'))?.id).toBe('e1');
  expect((await provider.get({ tag: 'status:200' })).data.map((e) => e.id)).toEqual(['e1', 'e2']);
  expect(await provider.tags('status:')).toEqual([{ tag: 'status:200', count: 2 }]);
  expect(await provider.prune(new Date(Date.now() - 3_600_000))).toBe(1);
  const histogram = Array.from({ length: HISTOGRAM_BUCKET_COUNT }, () => 0);
  await provider.recordRollups([
    { metric: 'm', bucketStart: 60_000, count: 1, sum: 5, max: 5, histogram },
  ]);
  await provider.recordRollups([
    { metric: 'm', bucketStart: 60_000, count: 2, sum: 6, max: 4, histogram },
  ]);
  const [bucket] = await provider.queryRollups(['m'], 0, 120_000);
  expect(bucket).toMatchObject({ metric: 'm', count: 3, sum: 11, max: 5 });
  expect(await provider.tryAcquireLease('prune', 'pod-a', 60_000, Date.now())).toBe(true);
  expect(await provider.tryAcquireLease('prune', 'pod-b', 60_000, Date.now())).toBe(false);
}

describe.skipIf(!docker)('schema option on PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let admin: MikroORM;

  const options = () => ({ driver: PostgreSqlDriver, clientUrl: container.getConnectionUri() });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    admin = await MikroORM.init({
      ...options(),
      entities: [],
      discovery: { warnWhenNoEntities: false },
    });
  }, 120_000);

  afterAll(async () => {
    await admin?.close(true);
    await container?.stop();
  });

  const tablesIn = async (schema: string): Promise<string[]> =>
    (
      await admin.em
        .getConnection()
        .execute<Array<{ table_name: string }>>(
          'select table_name from information_schema.tables where table_schema = ? order by table_name',
          [schema],
        )
    ).map((row: { table_name: string }) => row.table_name);

  it('creates the schema and puts every table, row and lease there, none in public', async () => {
    const provider = new MikroOrmStorageProvider(options(), { schema: SCHEMA });
    await provider.init();
    try {
      await exercise(provider);
    } finally {
      await provider.close();
    }
    expect(await tablesIn(SCHEMA)).toEqual(OWNED);
    expect(await tablesIn('public')).toEqual([]);
    const [rows] = await admin.em
      .getConnection()
      .execute<Array<{ n: string }>>(`select count(*) as n from "${SCHEMA}".telescope_entries`);
    expect(Number(rows?.n)).toBe(1);
  });

  it('a second boot reuses the schema (fingerprint gate) and sees the same rows', async () => {
    const provider = new MikroOrmStorageProvider(options(), { schema: SCHEMA });
    await provider.init();
    try {
      expect((await provider.find('e1'))?.id).toBe('e1');
    } finally {
      await provider.close();
    }
  });

  it('two schemas in one database stay apart', async () => {
    const other = new MikroOrmStorageProvider(options(), { schema: 'telescope_other' });
    await other.init();
    try {
      expect(await other.find('e1')).toBeNull();
      await other.store([entry('o1')]);
    } finally {
      await other.close();
    }
    expect(await tablesIn('telescope_other')).toEqual(OWNED);
    expect(await tablesIn('public')).toEqual([]);
  });

  it('works on an existing schema without CREATE rights on the database', async () => {
    const conn = admin.em.getConnection();
    await conn.execute('create schema if not exists restricted');
    await conn.execute("create role limited login password 'limited'");
    await conn.execute('grant usage, create on schema restricted to limited');
    await conn.execute(`revoke create on database "${container.getDatabase()}" from public`);
    const url = new URL(container.getConnectionUri());
    url.username = 'limited';
    url.password = 'limited';
    const provider = new MikroOrmStorageProvider(
      { driver: PostgreSqlDriver, clientUrl: url.toString() },
      { schema: 'restricted' },
    );
    await provider.init();
    try {
      await provider.store([entry('r1')]);
      expect((await provider.find('r1'))?.id).toBe('r1');
    } finally {
      await provider.close();
    }
    expect(await tablesIn('restricted')).toEqual(OWNED);
  });
});

describe.skipIf(!docker)('schema option on MySQL', () => {
  let container: StartedMySqlContainer;
  let admin: MikroORM;

  beforeAll(async () => {
    container = await new MySqlContainer('mysql:8.4').start();
    admin = await MikroORM.init({
      driver: MySqlDriver,
      host: container.getHost(),
      port: container.getPort(),
      user: 'root',
      password: container.getRootPassword(),
      dbName: container.getDatabase(),
      entities: [],
      discovery: { warnWhenNoEntities: false },
    });
  }, 180_000);

  afterAll(async () => {
    await admin?.close(true);
    await container?.stop();
  });

  const tablesIn = async (database: string): Promise<string[]> =>
    (
      await admin.em
        .getConnection()
        .execute<Array<{ TABLE_NAME?: string; table_name?: string }>>(
          'select table_name from information_schema.tables where table_schema = ? order by table_name',
          [database],
        )
    ).map(
      (row: { TABLE_NAME?: string; table_name?: string }) => row.TABLE_NAME ?? row.table_name ?? '',
    );

  it('creates the database named by `schema` and puts everything there, nothing in the default one', async () => {
    const provider = new MikroOrmStorageProvider(
      {
        driver: MySqlDriver,
        host: container.getHost(),
        port: container.getPort(),
        user: 'root',
        password: container.getRootPassword(),
        dbName: container.getDatabase(),
      },
      { schema: SCHEMA },
    );
    await provider.init();
    try {
      await exercise(provider);
    } finally {
      await provider.close();
    }
    expect(await tablesIn(SCHEMA)).toEqual(OWNED);
    expect(await tablesIn(container.getDatabase())).toEqual([]);
  });
});

describe('schema option on SQLite', () => {
  it('fails at init with a clear message', async () => {
    const provider = new MikroOrmStorageProvider(
      { driver: SqliteDriver, dbName: ':memory:' },
      { schema: SCHEMA },
    );
    await expect(provider.init()).rejects.toThrow(
      /`schema` \("telescope_obs"\) is not supported on SQLite/,
    );
  });

  it('without a schema, behaves as before', async () => {
    const provider = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: ':memory:' });
    await provider.init();
    try {
      await provider.store([entry('s1')]);
      expect((await provider.find('s1'))?.id).toBe('s1');
    } finally {
      await provider.close();
    }
  });
});
