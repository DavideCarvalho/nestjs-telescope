// packages/mikro-orm/src/overview-indexes.ts
//
// Opt-in indexes for the console's Overview and Pulse reads, and the schema heal's rule that keeps
// them (and any other index a host added) instead of dropping what the entities do not declare.
//
// They are NOT created at boot: on a table that already holds millions of entries, building an
// index blocks writes (except PostgreSQL's CONCURRENTLY, which cannot run inside the boot's
// transaction-free heal either without stalling the first request). A host creates them once,
// from a migration or a one-off script, with `createOverviewIndexes()` or the statements below.

/** The SQL dialects the opt-in indexes are written for. */
export type OverviewIndexDialect = 'postgres' | 'mysql' | 'sqlite';

/** The entries table the provider manages. */
const ENTRIES_TABLE = 'telescope_entries';

/** One opt-in index: its name, and its columns per dialect (`null`: not created there). */
interface OverviewIndex {
  name: string;
  postgres: string;
  mysql: string | null;
  sqlite: string | null;
}

/**
 * - `duration_ms` (rows with one): Pulse's "slowest" walks it from the top instead of sorting the
 *   window.
 * - `(created_at, type)`: the per-type (and per-minute) counts read the window from the index.
 * - `(type, created_at)` with `family_hash`, `batch_id`, `duration_ms` (PostgreSQL only): the
 *   per-family durations and the N+1 groups read only the index.
 */
const OVERVIEW_INDEXES: readonly OverviewIndex[] = [
  {
    name: `${ENTRIES_TABLE}_duration_ms_idx`,
    postgres: '(duration_ms) WHERE duration_ms IS NOT NULL',
    mysql: '(duration_ms)',
    sqlite: '(duration_ms) WHERE duration_ms IS NOT NULL',
  },
  {
    name: `${ENTRIES_TABLE}_created_at_type_idx`,
    postgres: '(created_at, type)',
    mysql: '(created_at, type)',
    sqlite: '(created_at, type)',
  },
  {
    name: `${ENTRIES_TABLE}_type_created_at_cover_idx`,
    postgres: '(type, created_at) INCLUDE (family_hash, batch_id, duration_ms)',
    mysql: null,
    sqlite: null,
  },
];

/** The names of the opt-in Overview indexes. */
export const OVERVIEW_INDEX_NAMES: readonly string[] = OVERVIEW_INDEXES.map((index) => index.name);

const quote = (dialect: OverviewIndexDialect, name: string) =>
  dialect === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;

/**
 * The statements that create the opt-in Overview indexes, idempotent where the dialect allows it.
 *
 * - PostgreSQL: `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (writes go on while they build; run them
 *   outside a transaction, one by one), then lower the table's autovacuum thresholds so the newest
 *   rows are read from the index too (index-only scans need the visibility map).
 * - MySQL / MariaDB: `ALTER TABLE … ADD INDEX …, ALGORITHM=INPLACE, LOCK=NONE` (online). MySQL has
 *   no `IF NOT EXISTS` here: skip the names that exist ({@link OVERVIEW_INDEX_NAMES}).
 * - SQLite: `CREATE INDEX IF NOT EXISTS` (it blocks writes while it builds).
 *
 * `schema` is the same value as the provider's `schema` setting (PostgreSQL / MySQL).
 */
export function overviewIndexStatements(
  dialect: OverviewIndexDialect,
  options: { schema?: string } = {},
): string[] {
  const table =
    options.schema !== undefined && options.schema !== ''
      ? `${quote(dialect, options.schema)}.${quote(dialect, ENTRIES_TABLE)}`
      : quote(dialect, ENTRIES_TABLE);
  const statements: string[] = [];
  for (const index of OVERVIEW_INDEXES) {
    const columns = index[dialect];
    if (columns === null) continue;
    const name = quote(dialect, index.name);
    if (dialect === 'postgres') {
      statements.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table} ${columns}`);
    } else if (dialect === 'mysql') {
      statements.push(
        `ALTER TABLE ${table} ADD INDEX ${name} ${columns}, ALGORITHM=INPLACE, LOCK=NONE`,
      );
    } else {
      statements.push(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} ${columns}`);
    }
  }
  if (dialect === 'postgres') {
    statements.push(
      `ALTER TABLE ${table} SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02)`,
    );
  }
  return statements;
}

/** Matches a statement that drops an index, capturing its (unquoted) name. */
const DROP_INDEX = [
  // PostgreSQL / SQLite: `drop index "name";`, `drop index "schema"."name";`
  /^drop index (?:if exists )?(?:[`"][^`"]+[`"]\.)?[`"]([^`"]+)[`"];?$/i,
  // MySQL / MariaDB: `alter table `t` drop index `name`;`
  /^alter table \S+ drop index [`"]([^`"]+)[`"];?$/i,
];

/**
 * `sql` (a schema diff, one statement per line) without the statements that drop an index the
 * entities do not declare: the heal adds what is missing and never removes an index a host added
 * (the opt-in Overview indexes, or its own). An index the diff drops to re-create it (its
 * definition changed) is still dropped.
 */
export function keepForeignIndexes(sql: string): string {
  const lines = sql.split('\n');
  return lines
    .filter((line) => {
      const statement = line.trim();
      for (const pattern of DROP_INDEX) {
        const name = pattern.exec(statement)?.[1];
        if (name === undefined) continue;
        const recreated = lines.some(
          (other) =>
            other !== line &&
            !/drop index/i.test(other) &&
            /\b(?:create(?: unique)? index|add(?: unique)? index|add constraint)\b/i.test(other) &&
            (other.includes(`"${name}"`) || other.includes(`\`${name}\``)),
        );
        return recreated;
      }
      return true;
    })
    .join('\n');
}
