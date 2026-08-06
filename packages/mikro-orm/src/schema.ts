// packages/mikro-orm/src/schema.ts
//
// The tables the `MikroOrmStorageProvider` boot-manages: `telescope_entries`,
// `telescope_rollups`, `telescope_leases`, and `telescope_schema_meta` (see
// mikro-orm-storage.provider.ts for the fingerprint-gated `schema.update`
// that reconciles them). A host that runs its OWN MikroORM CLI migrations
// against a shared database needs to keep its migration differ from ever
// trying to drop these — this module gives it that denylist without hand-
// maintaining a parallel string list that can drift from the entities.
import { TelescopeEntry } from './telescope-entry.entity.js';
import { TelescopeLease } from './telescope-lease.entity.js';
import { TelescopeRollup } from './telescope-rollup.entity.js';
import { TelescopeSchemaMeta } from './telescope-schema-meta.entity.js';

/**
 * Tables this package creates and manages at boot (autoSchema). Feed to your
 * ORM's migration differ skip/exclude list so it never tries to drop them.
 *
 * DERIVED from the four entities' own `tableName` — never a hardcoded
 * parallel literal list — so a future rename flows through automatically.
 * Includes `telescope_schema_meta` (the boot fingerprint marker): a migration
 * differ that doesn't know about it would try to drop it too.
 *
 * ```ts
 * await MikroORM.init({
 *   // ...your entities/driver config
 *   schemaGenerator: { skipTables: telescopeManagedTables() },
 * });
 * ```
 */
export function telescopeManagedTables(): string[] {
  return [
    TelescopeEntry.tableName,
    TelescopeRollup.tableName,
    TelescopeLease.tableName,
    TelescopeSchemaMeta.tableName,
  ];
}
