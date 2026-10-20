import { describeStorageProvider } from '@dudousxd/nestjs-telescope-testing/conformance';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { MikroOrmStorageProvider } from './mikro-orm-storage.provider.js';

describeStorageProvider(
  'MikroOrmStorageProvider (sqlite)',
  () => new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: ':memory:' }),
);
