import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';
import { EntryType } from '@dudousxd/nestjs-telescope';
// packages/mikro-orm/src/mikro-orm-query.watcher.ts
import { Logger } from '@nestjs/common';

export interface MikroOrmQueryWatcherOptions {
  slowMs?: number;
}

/**
 * Captures MikroORM queries and correlates them to the active request batch.
 *
 * ## Integration path: host-wired loggerFactory (v7.x)
 *
 * MikroORM v7 caches the logger instance at `Configuration` constructor time
 * (stored in a private `#logger` field). Runtime `config.set('loggerFactory')`
 * does NOT update the cached logger, so zero-config runtime-wrap is not
 * possible on v7.
 *
 * Instead, `register()` logs a clear warning and exposes `record` via
 * `ctx.record`. The host must wire the logger manually:
 *
 * ```ts
 * import { telescopeMikroOrmLogger } from '@dudousxd/nestjs-telescope-mikro-orm';
 *
 * // In your MikroORM config, before the ORM is constructed:
 * MikroOrmModule.forRootAsync({
 *   inject: [TelescopeService],
 *   useFactory: (telescope: TelescopeService) => ({
 *     debug: ['query'],
 *     loggerFactory: telescopeMikroOrmLogger((input) => telescope.record(input)),
 *     // ...rest of config
 *   }),
 * });
 * ```
 *
 * Queries recorded via `telescopeMikroOrmLogger` automatically inherit the
 * active ALS batch (set by the request middleware's `enterWith`), so they
 * correlate to their request.
 */
export class MikroOrmQueryWatcher implements Watcher {
  readonly type = EntryType.Query;
  private readonly logger = new Logger(MikroOrmQueryWatcher.name);

  constructor(private readonly options: MikroOrmQueryWatcherOptions = {}) {}

  register(_ctx: WatcherContext): void {
    this.logger.warn(
      [
        'MikroOrmQueryWatcher: MikroORM v7 caches its logger at construction time,',
        'so runtime logger replacement is not possible.',
        'To capture queries, add loggerFactory + debug to your MikroORM config:',
        '',
        "  import { telescopeMikroOrmLogger } from '@dudousxd/nestjs-telescope-mikro-orm';",
        '',
        '  MikroOrmModule.forRootAsync({',
        '    inject: [TelescopeService],',
        '    useFactory: (telescope: TelescopeService) => ({',
        "      debug: ['query'],",
        '      loggerFactory: telescopeMikroOrmLogger((input) => telescope.record(input)),',
        '    }),',
        '  });',
      ].join('\n'),
    );
    // slowMs option is available for consumers who use telescopeMikroOrmLogger directly.
    void this.options.slowMs;
  }
}
