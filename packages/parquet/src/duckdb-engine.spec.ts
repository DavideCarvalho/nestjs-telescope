import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEntry } from '@dudousxd/nestjs-telescope-testing/conformance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parquetColdStore } from './parquet-cold-store.js';

/** The slice of a DuckDB connection the assertions use; the engine keeps its own private. */
interface Connection {
  runAndReadAll(sql: string): Promise<{ getRowObjectsJS(): Record<string, unknown>[] }>;
  run(sql: string): Promise<unknown>;
}

describe('DuckDB engine', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'telescope-duckdb-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the cold tier without loading httpfs, and cannot be reconfigured to', async () => {
    const cold = parquetColdStore({ location: { dir }, engine: { duckdb: { threads: 1 } } });
    await cold.init();
    await cold.write([makeEntry({ id: 'a', createdAt: new Date(Date.now() - 60_000) })]);
    expect((await cold.query({})).map((entry) => entry.id)).toEqual(['a']);

    // The engine's own connection: the one every cold query runs on.
    const { connection } = (cold as unknown as { engine: { connection: Connection | null } })
      .engine;
    const loaded = await connection!.runAndReadAll(
      'SELECT extension_name FROM duckdb_extensions() WHERE loaded',
    );
    const names = loaded.getRowObjectsJS().map((row) => String(row.extension_name));
    expect(names).toContain('parquet');
    expect(names).not.toContain('httpfs');
    expect(names).not.toContain('aws');
    await expect(connection!.run('SET autoload_known_extensions = true')).rejects.toThrow();
    await cold.close();
  });

  it('names itself, so a host can confirm which engine is serving reads', () => {
    expect(parquetColdStore({ location: { dir } }).engineName).toBe('hyparquet');
    expect(parquetColdStore({ location: { dir }, engine: { duckdb: {} } }).engineName).toBe(
      'duckdb',
    );
  });
});
