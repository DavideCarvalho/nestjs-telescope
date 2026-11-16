// packages/mikro-orm/src/mikro-orm-storage.provider.aggregate.integration.spec.ts
//
// `aggregate` (pulse and the timeseries in SQL) on real PostgreSQL and MySQL, against the scan
// (testcontainers; skipped with TELESCOPE_SKIP_DOCKER=1). SQLite runs in the conformance suite.
import { describeStorageAggregation } from '@dudousxd/nestjs-telescope-testing/conformance';
import { MySqlDriver } from '@mikro-orm/mysql';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll } from 'vitest';
import { MikroOrmStorageProvider } from './mikro-orm-storage.provider.js';

const docker = process.env.TELESCOPE_SKIP_DOCKER !== '1';

let postgres: StartedPostgreSqlContainer | null = null;
let mysql: StartedMySqlContainer | null = null;
if (docker) {
  [postgres, mysql] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new MySqlContainer('mysql:8.4').start(),
  ]);
}

const providers: MikroOrmStorageProvider[] = [];
const once = (make: () => MikroOrmStorageProvider) => {
  let provider: MikroOrmStorageProvider | null = null;
  return () => {
    if (provider === null) {
      provider = make();
      providers.push(provider);
    }
    return provider;
  };
};

afterAll(async () => {
  for (const provider of providers) await provider.close();
  await Promise.all([postgres?.stop(), mysql?.stop()]);
});

const skip = docker ? {} : { skip: 'TELESCOPE_SKIP_DOCKER=1' };

describeStorageAggregation(
  'MikroOrmStorageProvider (PostgreSQL)',
  once(
    () =>
      new MikroOrmStorageProvider({
        driver: PostgreSqlDriver,
        clientUrl: postgres?.getConnectionUri() ?? '',
      }),
  ),
  { teardown: () => {}, timeoutMs: 60_000, ...skip },
);

describeStorageAggregation(
  'MikroOrmStorageProvider (MySQL)',
  once(
    () =>
      new MikroOrmStorageProvider({
        driver: MySqlDriver,
        host: mysql?.getHost() ?? '',
        port: mysql?.getPort() ?? 0,
        user: 'root',
        password: mysql?.getRootPassword() ?? '',
        dbName: mysql?.getDatabase() ?? '',
      }),
  ),
  { teardown: () => {}, timeoutMs: 60_000, ...skip },
);
