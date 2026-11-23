// packages/drizzle/src/overview-indexes.ts
//
// Opt-in indexes for the console's Overview and Pulse reads: the PostgreSQL set of
// `packages/mikro-orm/src/overview-indexes.ts`, under the same names, so a database that already
// has them from the MikroORM package is left as it is.
//
// They are NOT created at boot: on a table that already holds millions of entries an index build
// is a one-off job, and `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. A host runs
// them once, from a migration or a script, with `createOverviewIndexes()` or the statements below.
import { TELESCOPE_TABLES } from './schema.js';

/**
 * - `duration_ms` (rows with one): Pulse's "slowest" walks it from the top instead of sorting the
 *   window.
 * - `(created_at, type)`: the per-type (and per-minute) counts read the window from the index.
 * - `(type, created_at)` with `family_hash`, `batch_id`, `duration_ms`: the per-family durations
 *   and the N+1 groups read only the index.
 */
const OVERVIEW_INDEXES: readonly { name: string; columns: string }[] = [
  {
    name: `${TELESCOPE_TABLES.entries}_duration_ms_idx`,
    columns: '(duration_ms) WHERE duration_ms IS NOT NULL',
  },
  { name: `${TELESCOPE_TABLES.entries}_created_at_type_idx`, columns: '(created_at, type)' },
  {
    name: `${TELESCOPE_TABLES.entries}_type_created_at_cover_idx`,
    columns: '(type, created_at) INCLUDE (family_hash, batch_id, duration_ms)',
  },
];

/** The names of the opt-in Overview indexes. */
export const OVERVIEW_INDEX_NAMES: readonly string[] = OVERVIEW_INDEXES.map((index) => index.name);

/** A PostgreSQL identifier, double-quoted. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The statements that create the opt-in Overview indexes: `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
 * (writes go on while they build; run them outside a transaction, one by one), then a lower
 * autovacuum threshold for the table so the newest rows are read from the index too (index-only
 * scans need the visibility map).
 *
 * `schema` is the same value as the provider's `schema` setting.
 */
export function overviewIndexStatements(options: { schema?: string } = {}): string[] {
  const table =
    options.schema !== undefined && options.schema !== ''
      ? `${quoteIdentifier(options.schema)}.${quoteIdentifier(TELESCOPE_TABLES.entries)}`
      : quoteIdentifier(TELESCOPE_TABLES.entries);
  return [
    ...OVERVIEW_INDEXES.map(
      (index) =>
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdentifier(index.name)} ON ${table} ${index.columns}`,
    ),
    `ALTER TABLE ${table} SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02)`,
  ];
}
