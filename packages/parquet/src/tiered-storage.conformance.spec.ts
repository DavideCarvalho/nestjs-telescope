import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorageProvider, SqliteStorageProvider } from '@dudousxd/nestjs-telescope';
import type { StorageProvider } from '@dudousxd/nestjs-telescope';
import { describeStorageProvider } from '@dudousxd/nestjs-telescope-testing/conformance';
import { afterAll } from 'vitest';
import { archiveOlderHalf } from '../test/tiers.js';
import { type ColdEngineOption, parquetColdStore } from './parquet-cold-store.js';
import { tieredStorage } from './tiered-storage.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function onDisk(hot: () => StorageProvider, engine: ColdEngineOption = 'hyparquet') {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'telescope-cold-'));
    dirs.push(dir);
    return tieredStorage({ hot: hot(), cold: parquetColdStore({ location: { dir }, engine }) });
  };
}

describeStorageProvider(
  'tieredStorage (hot: in-memory, cold: dir, everything hot)',
  onDisk(() => new InMemoryStorageProvider()),
);

describeStorageProvider(
  'tieredStorage (hot: in-memory, cold: dir, older half archived)',
  onDisk(() => new InMemoryStorageProvider()),
  { afterSeed: archiveOlderHalf },
);

describeStorageProvider(
  'tieredStorage (hot: SQLite, cold: dir, older half archived)',
  onDisk(() => new SqliteStorageProvider()),
  { afterSeed: archiveOlderHalf },
);

describeStorageProvider(
  'tieredStorage (hot: in-memory, cold: dir via DuckDB, older half archived)',
  onDisk(() => new InMemoryStorageProvider(), { duckdb: { threads: 1 } }),
  { afterSeed: archiveOlderHalf },
);
