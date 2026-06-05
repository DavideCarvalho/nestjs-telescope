// integration/memory-soak/src/soak-bridge.ts
//
// Bridges per-request synthetic work into Telescope through the SAME record
// paths the real watchers use:
//  - cache emits go through the CacheWatcher's custom `instrument` -> `emit`
//    (held in CacheEmitHolder), so they carry the watcher's family-hash / tags
//    exactly like the incident's custom emitter.
//  - query records go straight to TelescopeService.record with the MikroORM
//    logger's `{ sql, bindings, took }` content shape and queryFamilyHash.

import {
  EntryType,
  type RecordInput,
  TelescopeService,
  queryFamilyHash,
} from '@dudousxd/nestjs-telescope';
import { Inject, Injectable } from '@nestjs/common';
import { CACHE_EMIT_HOLDER, CacheEmitHolder } from './cache-emit-holder.js';

const SOAK_QUERIES: readonly string[] = [
  'select * from base where id = ?',
  'select * from fleet where base_id = ? order by created_at desc',
  'select count(*) from booking where status = ?',
  'update base set updated_at = ? where id = ?',
  'select * from user where email = ? limit 1',
];

@Injectable()
export class SoakBridge {
  constructor(
    @Inject(TelescopeService) private readonly telescope: TelescopeService,
    @Inject(CACHE_EMIT_HOLDER) private readonly cache: CacheEmitHolder,
  ) {}

  /** Fire `count` cache hit/miss events for the active request batch. */
  emitCacheEvents(requestIndex: number, count: number): void {
    this.cache.fire(requestIndex, count);
  }

  /** Record `count` query entries shaped like the MikroORM logger emits. */
  recordQueries(requestIndex: number, count: number): void {
    for (let index = 0; index < count; index += 1) {
      const sql = SOAK_QUERIES[index % SOAK_QUERIES.length] ?? SOAK_QUERIES[0];
      if (sql === undefined) continue;
      const took = 1 + ((requestIndex + index) % 12);
      const input: RecordInput = {
        type: EntryType.Query,
        content: { sql, bindings: [requestIndex, index], took },
        familyHash: queryFamilyHash(sql),
        durationMs: took,
      };
      this.telescope.record(input);
    }
  }
}
