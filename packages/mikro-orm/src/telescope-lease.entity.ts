// packages/mikro-orm/src/telescope-lease.entity.ts
//
// Lease table backing the default cross-process prune lock. One row per lock
// name, holding who has it and when their claim lapses.
//
// Why a table and not a job engine, a Redis key, or an advisory lock: Telescope
// mounts into any NestJS app and must not require infrastructure the host does
// not already run. It DOES always have a database — that is where the entries
// live — so a row with an owner and an expiry is the one primitive guaranteed to
// exist on every supported provider. A host that owns something better supplies
// its own `prune.lock` implementation instead.
//
// `expires_at` is the whole point of the design rather than a detail: a pod that
// is SIGKILLed mid-prune never releases, and without an expiry that would stop
// the entire fleet from pruning forever. The lease is reclaimed once it lapses.
//
// Defined via EntitySchema (NOT decorators), like every other telescope entity,
// so the host needs no emitDecoratorMetadata. It is registered in the provider's
// OWNED single-purpose ORM and created by the same additive `schema.update` that
// manages `telescope_entries`.
import { BigIntType, EntitySchema } from '@mikro-orm/core';

export interface TelescopeLeaseRow {
  /** Lock name, e.g. `telescope:prune`. One row per lock. */
  key: string;
  /** Holder identity (`<instanceId>#<pid>`), so a release can be owner-checked. */
  owner: string;
  /** Epoch-ms after which the lease is abandoned and may be re-granted. */
  expiresAt: number;
}

// Epoch-ms, so a true SQL BIGINT is the right width on MySQL. Pinned to `number`
// mode (instead of the default `bigint`) so the JS value is a plain number and
// the row interface stays cast-free — matching the rollup/meta entities.
function bigintNumber(): BigIntType<'number'> {
  return new BigIntType('number');
}

export const TelescopeLease = new EntitySchema<TelescopeLeaseRow>({
  name: 'TelescopeLease',
  tableName: 'telescope_leases',
  properties: {
    // `lease_key`, not `key`: `key` is a reserved word in MySQL and would need
    // quoting on every statement.
    key: { type: 'string', primary: true, length: 64, fieldName: 'lease_key' },
    owner: { type: 'string', length: 200 },
    expiresAt: { type: bigintNumber(), fieldName: 'expires_at' },
  },
});
