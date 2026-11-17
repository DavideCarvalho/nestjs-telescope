// packages/mikro-orm/src/overview-indexes.spec.ts
//
// The opt-in Overview indexes, and the schema heal that keeps them (and any index a host added).
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';
import { MikroOrmStorageProvider } from './mikro-orm-storage.provider.js';
import {
  OVERVIEW_INDEX_NAMES,
  keepForeignIndexes,
  overviewIndexStatements,
} from './overview-indexes.js';

describe('overviewIndexStatements', () => {
  it('PostgreSQL: CONCURRENTLY, idempotent, schema-qualified, with the autovacuum thresholds', () => {
    const statements = overviewIndexStatements('postgres', { schema: 'telescope' });
    expect(statements).toHaveLength(4);
    for (const statement of statements.slice(0, 3)) {
      expect(statement).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS "telescope_entries_/);
      expect(statement).toContain('ON "telescope"."telescope_entries"');
    }
    expect(statements[2]).toContain('INCLUDE (family_hash, batch_id, duration_ms)');
    expect(statements[3]).toMatch(/^ALTER TABLE .* SET \(autovacuum_vacuum_scale_factor/);
  });

  it('MySQL: online ALTER TABLE, no covering index', () => {
    const statements = overviewIndexStatements('mysql');
    expect(statements).toEqual([
      'ALTER TABLE `telescope_entries` ADD INDEX `telescope_entries_duration_ms_idx` (duration_ms), ALGORITHM=INPLACE, LOCK=NONE',
      'ALTER TABLE `telescope_entries` ADD INDEX `telescope_entries_created_at_type_idx` (created_at, type), ALGORITHM=INPLACE, LOCK=NONE',
    ]);
  });

  it('SQLite: CREATE INDEX IF NOT EXISTS', () => {
    expect(overviewIndexStatements('sqlite')).toEqual([
      'CREATE INDEX IF NOT EXISTS "telescope_entries_duration_ms_idx" ON "telescope_entries" (duration_ms) WHERE duration_ms IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS "telescope_entries_created_at_type_idx" ON "telescope_entries" (created_at, type)',
    ]);
  });
});

describe('keepForeignIndexes', () => {
  it('takes out the drops of indexes the entities do not declare', () => {
    const sql = [
      'alter table "telescope_entries" add column "x" int null;',
      'drop index "telescope_entries_duration_ms_idx";',
      'drop index "telescope"."host_idx";',
      'alter table `telescope_entries` drop index `telescope_entries_created_at_type_idx`;',
      '',
    ].join('\n');
    expect(keepForeignIndexes(sql)).toBe(
      ['alter table "telescope_entries" add column "x" int null;', ''].join('\n'),
    );
  });

  it('keeps a drop the diff re-creates (a changed definition)', () => {
    const sql = [
      'drop index "telescope_entries_type_index";',
      'create index "telescope_entries_type_index" on "telescope_entries" ("type", "id");',
    ].join('\n');
    expect(keepForeignIndexes(sql)).toBe(sql);
  });
});

describe('MikroOrmStorageProvider overview indexes (sqlite)', () => {
  const dbFile = () => join(tmpdir(), `telescope-ovx-${process.pid}-${Math.random()}.sqlite`);

  it('creates them once, and a later schema heal keeps them and a host index', async () => {
    const file = dbFile();
    try {
      const first = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: file });
      await first.init();
      expect(await first.createOverviewIndexes()).toEqual([...OVERVIEW_INDEX_NAMES.slice(0, 2)]);
      expect(await first.createOverviewIndexes()).toEqual([]);
      const connection = (
        first as unknown as {
          orm: { em: { getConnection(): { execute(sql: string): Promise<unknown> } } };
        }
      ).orm.em.getConnection();
      await connection.execute('create index "host_idx" on "telescope_entries" ("origin")');
      // Force a heal on the next boot (as an upgrade that changes the schema would).
      await connection.execute('delete from "telescope_schema_meta"');
      await first.close();

      const second = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: file });
      await second.init();
      const rows = (await (
        second as unknown as {
          orm: {
            em: { getConnection(): { execute(sql: string): Promise<{ name: string }[]> } };
          };
        }
      ).orm.em
        .getConnection()
        .execute(
          "select name from sqlite_master where type = 'index' and tbl_name = 'telescope_entries'",
        )) as { name: string }[];
      const names = rows.map((row) => row.name);
      expect(names).toEqual(
        expect.arrayContaining([...OVERVIEW_INDEX_NAMES.slice(0, 2), 'host_idx']),
      );
      await second.close();
    } finally {
      rmSync(file, { force: true });
    }
  });
});
