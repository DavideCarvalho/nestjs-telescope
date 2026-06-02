// packages/mikro-orm/src/telescope-mikro-orm.logger.ts
import { EntryType, type RecordInput } from '@dudousxd/nestjs-telescope';
import { DefaultLogger, type LogContext, type LoggerOptions } from '@mikro-orm/core';
import { queryFamilyHash } from './query-family-hash.js';

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

  // DefaultLogger.logQuery signature is: (context: { query: string } & LogContext): void
  // We override using the Logger interface's looser LogContext so we can call super.
  override logQuery(context: LogContext): void {
    const sql = typeof context.query === 'string' ? context.query : '';
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
    // Cast to the concrete DefaultLogger signature — query is always a string here
    // since DefaultLogger.logQuery expects { query: string } & LogContext.
    super.logQuery(context as { query: string } & LogContext);
  }
}

/** Creates a `TelescopeMikroOrmLogger` with a no-op writer.
 *  Useful for testing and as a direct-use instance.
 *
 * For `loggerFactory` integration pass a real writer:
 * ```ts
 * MikroORM.init({
 *   debug: ['query'],
 *   loggerFactory: (opts) => new TelescopeMikroOrmLogger(opts, record, 100),
 * });
 * ```
 */
export function telescopeMikroOrmLogger(
  record: (input: RecordInput) => void,
  options: TelescopeLoggerOptions = {},
): TelescopeMikroOrmLogger {
  const slowMs = options.slowMs ?? 100;
  return new TelescopeMikroOrmLogger({ writer: () => undefined }, record, slowMs);
}
