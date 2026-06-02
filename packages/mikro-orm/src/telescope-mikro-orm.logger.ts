// packages/mikro-orm/src/telescope-mikro-orm.logger.ts
import { EntryType, type RecordInput, queryFamilyHash } from '@dudousxd/nestjs-telescope';
import { DefaultLogger, type LogContext, type LoggerOptions } from '@mikro-orm/core';

export interface TelescopeLoggerOptions {
  /** Queries at/above this many ms get a 'slow' tag. Default 100. */
  slowMs?: number;
}

/** A MikroORM DefaultLogger subclass that tees every executed query into
 *  `record`, while preserving MikroORM's own logging behavior via super. */
export class TelescopeMikroOrmLogger extends DefaultLogger {
  constructor(
    options: LoggerOptions,
    private readonly _record: (input: RecordInput) => void,
    private readonly slowMs: number,
  ) {
    super(options);
  }

  // Matches DefaultLogger.logQuery's concrete signature exactly.
  override logQuery(context: { query: string } & LogContext): void {
    const sql = context.query;
    if (sql) {
      const took = typeof context.took === 'number' ? context.took : null;
      const tags: string[] = took !== null && took >= this.slowMs ? ['slow'] : [];
      this._record({
        type: EntryType.Query,
        content: {
          sql,
          bindings: Array.isArray(context.params) ? [...context.params] : [],
          took,
        },
        familyHash: queryFamilyHash(sql),
        durationMs: took,
        ...(tags.length > 0 ? { tags } : {}),
      });
    }
    super.logQuery(context);
  }
}

/** Builds a `loggerFactory`-compatible function that records every query.
 *
 * Host-wired usage:
 * ```ts
 * MikroORM.init({
 *   debug: ['query'],
 *   loggerFactory: telescopeMikroOrmLogger(record, { slowMs: 100 }),
 * });
 * ```
 */
export function telescopeMikroOrmLogger(
  record: (input: RecordInput) => void,
  options: TelescopeLoggerOptions = {},
): (loggerOptions: LoggerOptions) => TelescopeMikroOrmLogger {
  const slowMs = options.slowMs ?? 100;
  return (loggerOptions: LoggerOptions) =>
    new TelescopeMikroOrmLogger(loggerOptions, record, slowMs);
}
