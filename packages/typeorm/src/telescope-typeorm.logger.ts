// packages/typeorm/src/telescope-typeorm.logger.ts
import { EntryType, type RecordInput, queryFamilyHash } from '@dudousxd/nestjs-telescope';
import type { Logger, QueryRunner } from 'typeorm';

export interface TelescopeTypeOrmLoggerOptions {
  /** Queries reported via `logQuerySlow` get a 'slow' tag. The threshold is
   *  owned by TypeORM's own `maxQueryExecutionTime`; this is kept for parity
   *  with the other adapters. Default 1000. */
  slowMs?: number;
}

/** A TypeORM `Logger` that tees every executed query into `record`.
 *
 * TypeORM's `logQuery` does not provide a duration, so `took`/`durationMs`
 * are `null` for normal queries. Slow queries are surfaced separately by
 * TypeORM via `logQuerySlow(time, ...)`, where the elapsed time IS available —
 * those are recorded with `durationMs` and a `slow` tag. */
export class TelescopeTypeOrmLogger implements Logger {
  constructor(
    private readonly record: (input: RecordInput) => void,
    private readonly slowMs = 1000,
  ) {}

  logQuery(query: string, parameters?: unknown[], _queryRunner?: QueryRunner): void {
    // TypeORM's logQuery gives no duration -> took/durationMs are null.
    this.record({
      type: EntryType.Query,
      content: {
        sql: query,
        bindings: Array.isArray(parameters) ? [...parameters] : [],
        took: null,
      },
      familyHash: queryFamilyHash(query),
      durationMs: null,
    });
  }

  logQuerySlow(
    time: number,
    query: string,
    parameters?: unknown[],
    _queryRunner?: QueryRunner,
  ): void {
    // TypeORM passes the elapsed time here, so we can record a real duration.
    this.record({
      type: EntryType.Query,
      content: {
        sql: query,
        bindings: Array.isArray(parameters) ? [...parameters] : [],
        took: time,
      },
      familyHash: queryFamilyHash(query),
      durationMs: time,
      tags: ['slow'],
    });
  }

  // Required by the Logger interface; kept as no-ops in v1.
  logQueryError(
    _error: string | Error,
    _query: string,
    _parameters?: unknown[],
    _queryRunner?: QueryRunner,
  ): void {}

  logSchemaBuild(_message: string, _queryRunner?: QueryRunner): void {}

  logMigration(_message: string, _queryRunner?: QueryRunner): void {}

  log(_level: 'log' | 'info' | 'warn', _message: unknown, _queryRunner?: QueryRunner): void {}
}

/** Builds a TypeORM-`Logger` instance that records every query.
 *
 * Host-wired usage — pass the instance to the `DataSource`'s `logger` option:
 * ```ts
 * new DataSource({
 *   // ...
 *   logging: true,
 *   logger: telescopeTypeOrmLogger((input) => telescopeService.record(input)),
 * });
 * ```
 *
 * Note: TypeORM's `logger` option takes a Logger INSTANCE (not a factory), so
 * this returns the instance directly — unlike MikroORM's loggerFactory. */
export function telescopeTypeOrmLogger(
  record: (input: RecordInput) => void,
  options: TelescopeTypeOrmLoggerOptions = {},
): TelescopeTypeOrmLogger {
  return new TelescopeTypeOrmLogger(record, options.slowMs ?? 1000);
}
