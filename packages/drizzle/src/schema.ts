// packages/drizzle/src/schema.ts
//
// The Drizzle (`pg-core`) definitions of the four tables the `DrizzleStorageProvider` manages:
// `telescope_entries`, `telescope_rollups`, `telescope_leases` and `telescope_schema_meta`.
//
// They are exported for two uses:
//
//  - A host that manages its schema with `drizzle-kit` imports them into its own schema file, so
//    `drizzle-kit generate` / `push` creates them (and never proposes dropping them). The provider
//    then runs with `ensureSchema: false`.
//  - A host that lets the provider create the tables at boot (the default) feeds
//    `telescopeManagedTables()` to `drizzle-kit`'s `tablesFilter` as `!`-prefixed patterns, so its
//    own migrations ignore them.
//
// Column types, lengths and index names match what `@dudousxd/nestjs-telescope-mikro-orm` creates
// on PostgreSQL, so a host can move between the two packages on the same database. The boot DDL in
// `boot-ddl.ts` creates exactly these definitions; a spec compares the catalog it leaves with
// drizzle-kit's `generateMigration` output for these tables.
import {
  bigint,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

/** Table names, unqualified. */
export const TELESCOPE_TABLES = {
  entries: 'telescope_entries',
  rollups: 'telescope_rollups',
  leases: 'telescope_leases',
  schemaMeta: 'telescope_schema_meta',
} as const;

/**
 * Builds the four table definitions, in `schema` when one is given (PostgreSQL schema, written
 * into every statement) or in the connection's default schema otherwise. `namespace` is that
 * `pgSchema` (or undefined): export it next to the tables so drizzle-kit creates the schema too.
 */
export function telescopeTables(schema?: string) {
  const namespace = schema === undefined || schema === '' ? undefined : pgSchema(schema);
  // One builder type for both: the schema only changes the qualified name, not the columns.
  const table = (namespace === undefined ? pgTable : namespace.table) as typeof pgTable;

  const entries = table(
    TELESCOPE_TABLES.entries,
    {
      id: varchar('id', { length: 64 }).primaryKey(),
      batchId: varchar('batch_id', { length: 64 }).notNull(),
      type: varchar('type', { length: 32 }).notNull(),
      familyHash: varchar('family_hash', { length: 64 }),
      content: jsonb('content').$type<unknown>().notNull(),
      tags: jsonb('tags').$type<string[]>().notNull(),
      // ` tag1 tag2 `: the tag filter is `tags_text LIKE '% <tag> %'`. `tags` stays the source of
      // truth for reads; this column only serves the filter.
      tagsText: text('tags_text').notNull(),
      sequence: integer('sequence').notNull(),
      durationMs: integer('duration_ms'),
      origin: varchar('origin', { length: 16 }).notNull(),
      instanceId: varchar('instance_id', { length: 128 }).notNull(),
      // 64: a traceId is caller-supplied and can be a 36-character UUID.
      traceId: varchar('trace_id', { length: 64 }),
      spanId: varchar('span_id', { length: 16 }),
      // Milliseconds: whole seconds would flatten a trace's waterfall.
      createdAt: timestamp('created_at', {
        precision: 3,
        withTimezone: true,
        mode: 'date',
      }).notNull(),
    },
    (t) => [
      index('telescope_entries_batch_id_index').on(t.batchId),
      index('telescope_entries_type_index').on(t.type),
      index('telescope_entries_family_hash_index').on(t.familyHash),
      index('telescope_entries_trace_id_index').on(t.traceId),
      index('telescope_entries_created_at_index').on(t.createdAt),
      // The pruner's per-type read: `type = ? AND created_at < ? ORDER BY created_at, id LIMIT n`.
      index('telescope_entries_type_created_at_id_index').on(t.type, t.createdAt, t.id),
    ],
  );

  const rollups = table(
    TELESCOPE_TABLES.rollups,
    {
      metric: varchar('metric', { length: 64 }).notNull(),
      // Epoch-ms bucket start and accumulating aggregates: well inside Number.MAX_SAFE_INTEGER.
      bucketStart: bigint('bucket_start', { mode: 'number' }).notNull(),
      count: bigint('count', { mode: 'number' }).notNull(),
      sum: bigint('sum', { mode: 'number' }).notNull(),
      max: bigint('max', { mode: 'number' }).notNull(),
      // Fixed-length latency histogram; null on rows written before the column existed.
      histogram: jsonb('histogram').$type<number[] | null>(),
    },
    (t) => [primaryKey({ name: 'telescope_rollups_pkey', columns: [t.metric, t.bucketStart] })],
  );

  const leases = table(TELESCOPE_TABLES.leases, {
    // `lease_key`, not `key`: the same column name the MikroORM package uses.
    key: varchar('lease_key', { length: 64 }).primaryKey(),
    owner: varchar('owner', { length: 200 }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  });

  const schemaMeta = table(TELESCOPE_TABLES.schemaMeta, {
    id: varchar('id', { length: 32 }).primaryKey(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    appliedAt: bigint('applied_at', { mode: 'number' }).notNull(),
  });

  return { entries, rollups, leases, schemaMeta, namespace };
}

export type TelescopeTables = ReturnType<typeof telescopeTables>;

const defaultTables = telescopeTables();

/** `telescope_entries` in the default schema. */
export const telescopeEntries = defaultTables.entries;
/** `telescope_rollups` in the default schema. */
export const telescopeRollups = defaultTables.rollups;
/** `telescope_leases` in the default schema. */
export const telescopeLeases = defaultTables.leases;
/** `telescope_schema_meta` in the default schema (the boot fingerprint marker). */
export const telescopeSchemaMeta = defaultTables.schemaMeta;

export type TelescopeEntryRow = typeof telescopeEntries.$inferSelect;
export type TelescopeRollupRow = typeof telescopeRollups.$inferSelect;

/**
 * Tables this package creates and manages at boot. Exclude them from your own migrations, for
 * example in `drizzle.config.ts`:
 *
 * ```ts
 * tablesFilter: ['*', ...telescopeManagedTables().map((name) => `!${name}`)],
 * ```
 *
 * Includes `telescope_schema_meta` (the boot fingerprint marker), which a migration differ that
 * does not know it would otherwise try to drop.
 */
export function telescopeManagedTables(): string[] {
  return [
    TELESCOPE_TABLES.entries,
    TELESCOPE_TABLES.rollups,
    TELESCOPE_TABLES.leases,
    TELESCOPE_TABLES.schemaMeta,
  ];
}
