// packages/mikro-orm/src/telescope-schema-meta.entity.ts
//
// Marker table backing the schema fingerprint gate. A SINGLE row keyed
// `id = 'mikro-orm'` records the fingerprint of the schema the provider last
// reconciled, plus the epoch-ms it was applied. On boot the provider compares
// the stored fingerprint against the one freshly computed from entity metadata;
// when they match it SKIPS the expensive whole-database `schema.update`
// introspection entirely (see mikro-orm-storage.provider.ts).
//
// Defined via EntitySchema (NOT decorators), like the other telescope entities,
// so the host needs no emitDecoratorMetadata. It is registered in the provider's
// OWNED single-purpose ORM so `em.upsert` can write the marker driver-agnostically.
// It is deliberately EXCLUDED from the fingerprint payload itself (the gate only
// fingerprints `telescope_entries` + `telescope_rollups`), so the marker's own
// shape never invalidates the gate.
import { BigIntType, EntitySchema } from '@mikro-orm/core';

export interface TelescopeSchemaMetaRow {
  /** Fixed key for the single marker row; always `'mikro-orm'`. */
  id: string;
  /** sha256 hex of the reconciled schema fingerprint. */
  fingerprint: string;
  /** Epoch-ms the fingerprint was last applied. */
  appliedAt: number;
}

// `applied_at` is an epoch-ms timestamp, so a true SQL BIGINT is the right width
// on MySQL. Pinned to `number` mode (instead of the default `bigint`) so the
// JS-side value is a plain number and the row interface stays cast-free —
// matching the rollup entity's bigint columns.
function bigintNumber(): BigIntType<'number'> {
  return new BigIntType('number');
}

export const TelescopeSchemaMeta = new EntitySchema<TelescopeSchemaMetaRow>({
  name: 'TelescopeSchemaMeta',
  tableName: 'telescope_schema_meta',
  properties: {
    id: { type: 'string', primary: true, length: 32 },
    fingerprint: { type: 'string', length: 64 },
    appliedAt: { type: bigintNumber(), fieldName: 'applied_at' },
  },
});
