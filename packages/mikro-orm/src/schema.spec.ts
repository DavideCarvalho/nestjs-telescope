// packages/mikro-orm/src/schema.spec.ts
import { describe, expect, it } from 'vitest';
import { telescopeManagedTables } from './schema.js';
import { TelescopeEntry } from './telescope-entry.entity.js';
import { TelescopeLease } from './telescope-lease.entity.js';
import { TelescopeRollup } from './telescope-rollup.entity.js';
import { TelescopeSchemaMeta } from './telescope-schema-meta.entity.js';

describe('telescopeManagedTables', () => {
  it('returns exactly the 4 tables the storage provider boot-manages', () => {
    expect(telescopeManagedTables()).toEqual([
      'telescope_entries',
      'telescope_rollups',
      'telescope_leases',
      'telescope_schema_meta',
    ]);
  });

  it('includes the prune-lock lease table (a differ would drop it too)', () => {
    expect(telescopeManagedTables()).toContain('telescope_leases');
  });

  it('includes the schema-meta marker table (a differ would drop it too)', () => {
    expect(telescopeManagedTables()).toContain('telescope_schema_meta');
  });

  it('stays in sync with the entities — asserted against their own metadata, not literals', () => {
    expect(telescopeManagedTables()).toEqual([
      TelescopeEntry.tableName,
      TelescopeRollup.tableName,
      TelescopeLease.tableName,
      TelescopeSchemaMeta.tableName,
    ]);
  });

  it('returns a fresh array each call (no shared mutable state)', () => {
    const first = telescopeManagedTables();
    const second = telescopeManagedTables();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
