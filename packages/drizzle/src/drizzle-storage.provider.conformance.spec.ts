// packages/drizzle/src/drizzle-storage.provider.conformance.spec.ts
//
// The whole StorageProvider contract (aggregation included) on real PostgreSQL, three ways: Pool
// options (an owned pool), the host's Drizzle database (a borrowed pool), and a `schema`.
import type { StorageProvider } from '@dudousxd/nestjs-telescope';
import { describeStorageProvider } from '@dudousxd/nestjs-telescope-testing/conformance';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll } from 'vitest';
import { startPostgres } from '../test/postgres.js';
import { DrizzleStorageProvider } from './drizzle-storage.provider.js';

const postgres = await startPostgres();
const hostPool = new pg.Pool({ connectionString: postgres.url, max: 4 });

afterAll(async () => {
  await hostPool.end();
  await postgres.container?.stop();
});

const skip = postgres.skipReason === null ? {} : { skip: postgres.skipReason };

/**
 * Leases outlive `clear()` by design (a prune in progress keeps its lock), and every test reuses
 * the same database, so each test ends by dropping them.
 */
const teardownIn =
  (table: string) =>
  async (provider: StorageProvider): Promise<void> => {
    await hostPool.query(`delete from ${table}`);
    await provider.close?.();
  };

describeStorageProvider(
  'DrizzleStorageProvider (PostgreSQL, owned pool)',
  () => new DrizzleStorageProvider({ connectionString: postgres.url }),
  { teardown: teardownIn('telescope_leases'), timeoutMs: 60_000, ...skip },
);

describeStorageProvider(
  "DrizzleStorageProvider (PostgreSQL, the host's NodePgDatabase)",
  () => new DrizzleStorageProvider(drizzle({ client: hostPool })),
  { teardown: teardownIn('telescope_leases'), timeoutMs: 60_000, ...skip },
);

describeStorageProvider(
  'DrizzleStorageProvider (PostgreSQL, own schema)',
  () => new DrizzleStorageProvider({ connectionString: postgres.url }, { schema: 'telescope_obs' }),
  {
    teardown: teardownIn('telescope_obs.telescope_leases'),
    timeoutMs: 60_000,
    ...skip,
  },
);
