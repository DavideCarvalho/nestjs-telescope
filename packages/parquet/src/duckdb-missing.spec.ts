import { describe, expect, it, vi } from 'vitest';
import { parquetColdStore } from './parquet-cold-store.js';

vi.mock('@duckdb/node-api', () => {
  throw new Error("Cannot find package '@duckdb/node-api'");
});

describe('DuckDB engine without @duckdb/node-api installed', () => {
  it('fails at init with an error naming the missing peer, instead of falling back', async () => {
    const cold = parquetColdStore({ location: { dir: '/nonexistent' }, engine: { duckdb: {} } });
    await expect(cold.init()).rejects.toThrow(
      /engine "duckdb" is configured but @duckdb\/node-api is not installed/,
    );
  });
});
