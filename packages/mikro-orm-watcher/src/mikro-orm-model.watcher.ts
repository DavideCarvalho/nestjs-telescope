// packages/mikro-orm-watcher/src/mikro-orm-model.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
} from '@dudousxd/nestjs-telescope';
import { MikroORM, wrap } from '@mikro-orm/core';
import { Logger } from '@nestjs/common';

/** A MikroORM lifecycle event payload (structural — the subset we read from
 *  `EventArgs`). `entity` is the affected entity instance, `meta` carries the
 *  entity metadata, `changeSet` the diff (absent on deletes). */
export interface MikroOrmEventArgs {
  entity: object;
  meta?: { className?: string; name?: string };
  changeSet?: { payload?: Record<string, unknown> };
}

/** The structural surface we need from a resolved `MikroORM` instance: an
 *  `EntityManager` whose event manager accepts a subscriber registration. */
export interface MikroOrmLike {
  em: {
    getEventManager(): {
      registerSubscriber(subscriber: unknown): void;
    };
  };
}

/** Telescope's own storage entities — never recorded, to avoid a feedback loop
 *  where persisting an entry triggers another model entry. */
const TELESCOPE_ENTITY_NAMES = new Set(['TelescopeEntry', 'TelescopeRollup']);

/** Narrows a resolved provider to a usable `MikroORM`-like instance. */
function hasEventManager(value: unknown): value is MikroOrmLike {
  if (typeof value !== 'object' || value === null || !('em' in value)) return false;
  const em = (value as { em: unknown }).em;
  return (
    typeof em === 'object' &&
    em !== null &&
    'getEventManager' in em &&
    typeof (em as { getEventManager: unknown }).getEventManager === 'function'
  );
}

/** Resolve the className for an event, preferring `meta.className`. */
function resolveEntityName(args: MikroOrmEventArgs): string {
  return args.meta?.className ?? args.meta?.name ?? args.entity.constructor.name;
}

/** Resolve the entity's primary key as a string, or null when unassigned.
 *  `wrap(entity, true)` returns the internal wrapper, which exposes
 *  `getPrimaryKey()`. */
function resolvePrimaryKey(entity: object): string | null {
  try {
    const primaryKey = wrap(entity, true).getPrimaryKey();
    return primaryKey === null || primaryKey === undefined ? null : String(primaryKey);
  } catch {
    return null;
  }
}

/**
 * Captures MikroORM entity lifecycle changes (create / update / delete) and
 * records a `model` entry per change, correlated to the active request/job
 * batch.
 *
 * ## How it works
 * At registration the watcher resolves the host's `MikroORM` from the Nest
 * container (`ctx.moduleRef.get(MikroORM, { strict: false })`) and registers an
 * `EventSubscriber` on the EntityManager's event manager
 * (`orm.em.getEventManager().registerSubscriber(...)`). On each `afterCreate` /
 * `afterUpdate` / `afterDelete` hook it records
 * `{ action, entity, id, changes }`. The subscriber runs in the flushing async
 * context, so each entry lands in the request/job batch that triggered the
 * flush — no batch is opened here. Payload (`changes`) redaction is applied
 * downstream by the Recorder.
 *
 * ## Feedback-loop guard
 * Telescope's own storage entities (`TelescopeEntry` / `TelescopeRollup`) are
 * skipped by class name, so persisting an entry never records another entry.
 *
 * ## Resilience
 * If `@mikro-orm/core` / `MikroORM` isn't available, or the resolved provider
 * has no usable event manager, the watcher logs a warning and no-ops — it never
 * throws. Registration is idempotent (a guard flag).
 */
export class MikroOrmModelWatcher implements Watcher {
  readonly type = EntryType.Model;
  private readonly logger = new Logger(MikroOrmModelWatcher.name);
  private registered = false;

  register(ctx: WatcherContext): void {
    if (this.registered) return;
    this.registered = true;

    const orm = this.resolveOrm(ctx);
    if (!orm) {
      this.logger.warn(
        'MikroOrmModelWatcher: MikroORM (@mikro-orm/core) not found or has no event manager. ' +
          'Model changes will not be captured.',
      );
      return;
    }

    const watcher = this;
    const subscriber = {
      afterCreate(args: MikroOrmEventArgs): void {
        watcher.safeRecord(ctx, 'create', args);
      },
      afterUpdate(args: MikroOrmEventArgs): void {
        watcher.safeRecord(ctx, 'update', args);
      },
      afterDelete(args: MikroOrmEventArgs): void {
        watcher.safeRecord(ctx, 'delete', args);
      },
    };

    try {
      orm.em.getEventManager().registerSubscriber(subscriber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`MikroOrmModelWatcher: failed to register subscriber: ${message}`);
    }
  }

  /** Resolve the singleton `MikroORM` from the Nest container; null when the
   *  optional peer isn't wired or the provider has no event manager. */
  private resolveOrm(ctx: WatcherContext): MikroOrmLike | null {
    try {
      const found = ctx.moduleRef.get(MikroORM, { strict: false });
      return hasEventManager(found) ? found : null;
    } catch {
      return null;
    }
  }

  /** Build + record a model entry, skipping Telescope's own entities and
   *  swallowing any failure so a telescope error can never break a flush. */
  private safeRecord(
    ctx: WatcherContext,
    action: 'create' | 'update' | 'delete',
    args: MikroOrmEventArgs,
  ): void {
    try {
      const entity = resolveEntityName(args);
      if (TELESCOPE_ENTITY_NAMES.has(entity)) return;

      const input: RecordInput = {
        type: EntryType.Model,
        familyHash: `model:${entity}:${action}`,
        tags: ['model', `model:${action}`, `entity:${entity}`],
        content: {
          action,
          entity,
          id: resolvePrimaryKey(args.entity),
          changes: args.changeSet?.payload ?? null,
        },
      };
      ctx.record(input);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`MikroOrmModelWatcher: failed to record model change: ${message}`);
    }
  }
}
