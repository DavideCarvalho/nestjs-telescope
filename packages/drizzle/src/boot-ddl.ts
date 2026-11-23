// packages/drizzle/src/boot-ddl.ts
//
// The DDL `DrizzleStorageProvider.init()` runs when `ensureSchema` is on, and the fingerprint gate
// that skips it on every boot after the first.
//
// The statements are additive and idempotent: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
// EXISTS` for the nullable columns a table created by an older release (including one created by
// the MikroORM package) may lack, and `CREATE INDEX IF NOT EXISTS`. Nothing is ever dropped, so an
// index a host added, or the opt-in Overview indexes, survive every boot.
//
// Why a gate when every statement is idempotent: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` takes
// the table's ACCESS EXCLUSIVE lock before it finds the column there, so on a busy table it queues
// behind long reads and blocks every write while it waits. The gate keeps a sha256 of the
// statements in `telescope_schema_meta` (row `drizzle`) and runs them only when it differs: a
// fresh database, a release that changed the DDL, or a new `schema`.
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { quoteIdentifier } from './overview-indexes.js';
import { TELESCOPE_TABLES } from './schema.js';

/** The key of this package's row in `telescope_schema_meta` (the MikroORM package uses its own). */
export const SCHEMA_META_ID = 'drizzle';

/**
 * Hand-bump escape hatch for a change the statement text does not show (none so far). Bumping it
 * makes every install run the DDL once more.
 */
const SCHEMA_REVISION = 1;

const SCHEMA_LOCK_NAME = 'telescope_schema';

/** `table`, quoted, and qualified with `schema` when there is one. */
export function qualified(table: string, schema: string | undefined): string {
  return schema === undefined
    ? quoteIdentifier(table)
    : `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

/** The marker table, created before the gate reads it. */
export function schemaMetaDdl(schema: string | undefined): string {
  return `create table if not exists ${qualified(TELESCOPE_TABLES.schemaMeta, schema)} ("id" varchar(32) primary key not null, "fingerprint" varchar(64) not null, "applied_at" bigint not null)`;
}

/** Every statement that brings the managed tables to the shape `schema.ts` declares. */
export function bootStatements(schema: string | undefined): string[] {
  const entries = qualified(TELESCOPE_TABLES.entries, schema);
  const rollups = qualified(TELESCOPE_TABLES.rollups, schema);
  const leases = qualified(TELESCOPE_TABLES.leases, schema);
  const index = (name: string, columns: string): string =>
    `create index if not exists ${quoteIdentifier(name)} on ${entries} using btree (${columns})`;

  return [
    `create table if not exists ${entries} (
      "id" varchar(64) primary key not null,
      "batch_id" varchar(64) not null,
      "type" varchar(32) not null,
      "family_hash" varchar(64),
      "content" jsonb not null,
      "tags" jsonb not null,
      "tags_text" text not null,
      "sequence" integer not null,
      "duration_ms" integer,
      "origin" varchar(16) not null,
      "instance_id" varchar(128) not null,
      "trace_id" varchar(64),
      "span_id" varchar(16),
      "created_at" timestamp(3) with time zone not null
    )`,
    `alter table ${entries} add column if not exists "family_hash" varchar(64)`,
    `alter table ${entries} add column if not exists "duration_ms" integer`,
    `alter table ${entries} add column if not exists "trace_id" varchar(64)`,
    `alter table ${entries} add column if not exists "span_id" varchar(16)`,
    index('telescope_entries_batch_id_index', '"batch_id"'),
    index('telescope_entries_type_index', '"type"'),
    index('telescope_entries_family_hash_index', '"family_hash"'),
    index('telescope_entries_trace_id_index', '"trace_id"'),
    index('telescope_entries_created_at_index', '"created_at"'),
    index('telescope_entries_type_created_at_id_index', '"type", "created_at", "id"'),
    `create table if not exists ${rollups} (
      "metric" varchar(64) not null,
      "bucket_start" bigint not null,
      "count" bigint not null,
      "sum" bigint not null,
      "max" bigint not null,
      "histogram" jsonb,
      constraint "telescope_rollups_pkey" primary key ("metric", "bucket_start")
    )`,
    `alter table ${rollups} add column if not exists "histogram" jsonb`,
    `create table if not exists ${leases} (
      "lease_key" varchar(64) primary key not null,
      "owner" varchar(200) not null,
      "expires_at" bigint not null
    )`,
  ];
}

/** sha256 of the statements and the revision: what the gate compares. */
export function bootFingerprint(schema: string | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify({ revision: SCHEMA_REVISION, statements: bootStatements(schema) }))
    .digest('hex');
}

/** The stored fingerprint, or null when there is none: no row, no marker table, no schema yet. */
async function storedFingerprint(
  db: Pool | PoolClient,
  schema: string | undefined,
): Promise<string | null> {
  try {
    const result = await db.query<{ fingerprint: string }>(
      `select "fingerprint" from ${qualified(TELESCOPE_TABLES.schemaMeta, schema)} where "id" = $1`,
      [SCHEMA_META_ID],
    );
    return result.rows[0]?.fingerprint ?? null;
  } catch (error) {
    // 42P01 undefined_table, 3F000 invalid_schema_name: a database Telescope never booted on.
    const code = (error as { code?: string }).code;
    if (code === '42P01' || code === '3F000') return null;
    throw error;
  }
}

/**
 * Creates `schema` when it does not exist. Looks it up in the catalog by name first, so a role
 * without CREATE rights on the database works against a schema that already exists.
 */
async function ensureNamespace(client: PoolClient, schema: string): Promise<void> {
  const found = await client.query(
    'select 1 from information_schema.schemata where schema_name = $1',
    [schema],
  );
  if (found.rows.length > 0) return;
  await client.query(`create schema if not exists ${quoteIdentifier(schema)}`);
}

/**
 * Brings the managed tables up to date, once per DDL change (see the file header). A boot that
 * finds the fingerprint current runs one SELECT and nothing else.
 *
 * Otherwise it takes a session advisory lock (one per schema) on one pooled client, re-reads the
 * fingerprint, and only then creates the schema, the marker table and the rest: concurrent first
 * boots would otherwise race on `CREATE ... IF NOT EXISTS`, which PostgreSQL does not make safe
 * between sessions.
 */
export async function reconcileSchema(pool: Pool, schema: string | undefined): Promise<void> {
  const expected = bootFingerprint(schema);
  if ((await storedFingerprint(pool, schema)) === expected) return;

  const lockName = schema === undefined ? SCHEMA_LOCK_NAME : `${SCHEMA_LOCK_NAME}:${schema}`;
  const client = await pool.connect();
  // A client whose unlock failed may still hold the lock: it is destroyed, not returned to the pool.
  let destroy = false;
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [lockName]);
    try {
      if ((await storedFingerprint(client, schema)) === expected) return;
      if (schema !== undefined) await ensureNamespace(client, schema);
      await client.query(schemaMetaDdl(schema));
      for (const statement of bootStatements(schema)) await client.query(statement);
      await client.query(
        `insert into ${qualified(TELESCOPE_TABLES.schemaMeta, schema)} ("id", "fingerprint", "applied_at") values ($1, $2, $3)
         on conflict ("id") do update set "fingerprint" = excluded."fingerprint", "applied_at" = excluded."applied_at"`,
        [SCHEMA_META_ID, expected, Date.now()],
      );
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => {
        destroy = true;
      });
    }
  } finally {
    client.release(destroy);
  }
}
