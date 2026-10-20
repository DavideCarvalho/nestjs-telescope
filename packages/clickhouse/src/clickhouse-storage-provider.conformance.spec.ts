import { describeStorageProvider } from '@dudousxd/nestjs-telescope-testing/conformance';
import { afterAll } from 'vitest';
import {
  CLICKHOUSE_PASSWORD,
  CLICKHOUSE_USER,
  startClickHouse,
} from '../test/clickhouse-container.js';
import { ClickHouseStorageProvider } from './clickhouse-storage-provider.js';

const server = await startClickHouse();

const provider = server
  ? new ClickHouseStorageProvider({
      url: server.baseUrl,
      // An externally provided URL carries its own credentials.
      ...(process.env.CLICKHOUSE_URL
        ? {}
        : { username: CLICKHOUSE_USER, password: CLICKHOUSE_PASSWORD }),
      database: 'telescope',
      table: 'conformance_entries',
      rollupTable: 'conformance_rollups',
      retention: { default: '30d' },
    })
  : null;

afterAll(async () => {
  await provider?.close();
  await server?.stop();
});

describeStorageProvider(
  `ClickHouseStorageProvider (${server?.describedAs ?? 'ClickHouse'})`,
  () => provider as ClickHouseStorageProvider,
  {
    retention: 'ttl',
    // One shared client for the whole run.
    teardown: () => {},
    ...(provider === null ? { skip: 'no CLICKHOUSE_URL and no Docker daemon' } : {}),
  },
);
