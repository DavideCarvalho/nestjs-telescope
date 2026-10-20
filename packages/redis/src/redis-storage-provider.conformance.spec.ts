import { describeStorageProvider } from '@dudousxd/nestjs-telescope-testing/conformance';
import { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterAll } from 'vitest';
import { startRedis } from '../test/redis-container.js';
import { RedisStorageProvider } from './redis-storage-provider.js';

describeStorageProvider(
  'RedisStorageProvider (ioredis-mock)',
  () => new RedisStorageProvider(new RedisMock() as unknown as Redis),
);

// A real server too: the mock does not implement every command exactly as Redis does.
const server = await startRedis();
const client = server ? new Redis(server.connection) : null;

afterAll(async () => {
  await client?.quit();
  await server?.stop();
});

describeStorageProvider(
  `RedisStorageProvider (${server?.describedAs ?? 'real Redis'})`,
  () => new RedisStorageProvider(client as Redis),
  server === null ? { skip: 'no REDIS_URL and no Docker daemon' } : {},
);
