// packages/mikro-orm/src/telescope-entry.entity.ts
//
// Telescope entry persistence schema, defined via EntitySchema (NOT decorators)
// so the host does not need emitDecoratorMetadata. The host registers
// `TelescopeEntry` in their MikroORM `entities` array.
//
// `tagsText` is a space-padded join of the entry's tags (` tag1 tag2 `) used as a
// cross-driver tag filter index: JSON-array querying is not portable across
// MySQL and SQLite, so we filter on `tagsText` with `LIKE '% <tag> %'`. The
// `tags` JSON column remains the source of truth for retrieval; `tagsText` is
// only an index for filtering.
import { EntitySchema } from '@mikro-orm/core';

export interface TelescopeEntryRow {
  id: string;
  batchId: string;
  type: string;
  familyHash: string | null;
  content: unknown;
  tags: string[];
  tagsText: string;
  sequence: number;
  durationMs: number | null;
  origin: string;
  instanceId: string;
  traceId: string | null;
  spanId: string | null;
  createdAt: Date;
}

export const TelescopeEntry = new EntitySchema<TelescopeEntryRow>({
  name: 'TelescopeEntry',
  tableName: 'telescope_entries',
  properties: {
    id: { type: 'string', primary: true, length: 64 },
    batchId: { type: 'string', length: 64, index: true },
    type: { type: 'string', length: 32, index: true },
    familyHash: { type: 'string', nullable: true, length: 64, index: true },
    content: { type: 'json' },
    tags: { type: 'json' },
    tagsText: { type: 'text' },
    sequence: { type: 'integer' },
    durationMs: { type: 'integer', nullable: true },
    origin: { type: 'string', length: 16 },
    instanceId: { type: 'string', length: 128 },
    // Indexed: the #/traces/:id view filters entries by traceId. Without this,
    // that lookup is a full table scan (every other filterable column — type,
    // batchId, familyHash, createdAt — is already indexed). `schema.update`
    // adds the index additively on the next boot (no migration).
    traceId: { type: 'string', nullable: true, length: 32, index: true },
    spanId: { type: 'string', nullable: true, length: 16 },
    createdAt: { type: 'datetime', index: true },
  },
});
