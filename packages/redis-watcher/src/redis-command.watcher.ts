// packages/redis-watcher/src/redis-command.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
} from '@dudousxd/nestjs-telescope';

/** A single ioredis command, structurally. `name` is the command (e.g. `get`);
 *  `args` are its arguments. */
export interface RedisCommandLike {
  name: string;
  args: unknown[];
}

/** The structural ioredis client surface we wrap. `sendCommand` is the single
 *  funnel every command goes through, so wrapping it captures everything. */
export interface RedisClientLike {
  sendCommand(command: RedisCommandLike, ...rest: unknown[]): unknown;
}

/** A custom instrumentation hook: the host resolves its own client from
 *  `ctx.moduleRef` (or elsewhere) and hands it back via `use`. Mirrors the
 *  custom-source path on other watchers — the watcher wraps whatever client the
 *  host provides. */
export interface CustomRedisSource {
  instrument(use: (client: RedisClientLike) => void, ctx: WatcherContext): void;
}

/** Narrows the constructor argument to a {@link CustomRedisSource} (instrument
 *  path) vs a {@link RedisClientLike} (direct-client path). */
function isCustomRedisSource(
  source: RedisClientLike | CustomRedisSource,
): source is CustomRedisSource {
  return 'instrument' in source && typeof source.instrument === 'function';
}

/** Marks a client whose `sendCommand` we've already wrapped, so re-registering
 *  the same instance (or two watchers sharing it) never double-wraps. */
const PATCHED = Symbol.for('@dudousxd/nestjs-telescope:redisPatched');

/** A wrappable client carrying our idempotency brand. */
interface BrandedRedisClient extends RedisClientLike {
  [PATCHED]?: boolean;
}

/** Narrows an arbitrary client to one with a usable `sendCommand` (and our
 *  optional brand). */
function hasSendCommand(value: unknown): value is BrandedRedisClient {
  if (typeof value !== 'object' || value === null || !('sendCommand' in value)) return false;
  const sendCommand = (value as { sendCommand: unknown }).sendCommand;
  return typeof sendCommand === 'function';
}

/** Best-effort high-resolution clock; falls back to `Date.now()`. */
function now(): number {
  return typeof performance === 'object' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** True when a value looks like a thenable (so we can time the round-trip). */
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then: unknown }).then === 'function'
  );
}

/**
 * Captures every Redis command issued through a wrapped `ioredis` client and
 * records a `redis` entry per command (`{ command, args, durationMs }`),
 * correlated to the request/job that issued it.
 *
 * ## How it works
 * Every ioredis command funnels through `client.sendCommand(command)`. The
 * watcher monkey-patches that method on the host's client instance: it captures
 * the command name + args, times the round-trip via the command's returned
 * promise, and records the entry. The original is always called and its result
 * returned/thrown unchanged — recording failures are swallowed so a telescope
 * error can never alter a command's outcome. The wrap runs in the caller's async
 * context (the active request/job ALS scope), so each entry lands in the right
 * batch — no batch is opened here.
 *
 * ## Two construction forms
 * - `new RedisCommandWatcher(ioredisClient)` — wrap a client you already hold.
 * - `new RedisCommandWatcher({ instrument })` — resolve the client lazily inside
 *   `register()` (e.g. from `ctx.moduleRef`) and hand it back via `use`.
 *
 * ## Resilience
 * If the client lacks `sendCommand`, the watcher logs nothing destructive and
 * no-ops. Patching is per-instance and idempotent (a `Symbol.for` marker), and
 * `cleanup()` restores the original `sendCommand`.
 *
 * ## Caveat
 * The watcher records exactly what the wrapped client does. If the host shares
 * one client with Telescope's own redis storage, those storage commands would be
 * captured too — pass a dedicated/observed client to avoid that noise.
 */
export class RedisCommandWatcher implements Watcher {
  readonly type = EntryType.Redis;
  private readonly source: RedisClientLike | CustomRedisSource;
  private patched: BrandedRedisClient | null = null;
  private original: RedisClientLike['sendCommand'] | null = null;

  constructor(source: RedisClientLike | CustomRedisSource) {
    this.source = source;
  }

  register(ctx: WatcherContext): void {
    if (isCustomRedisSource(this.source)) {
      this.source.instrument((client) => {
        this.wrap(ctx, client);
      }, ctx);
      return;
    }
    this.wrap(ctx, this.source);
  }

  /** Restore the original `sendCommand` if we wrapped it. Safe to call when
   *  never registered. */
  cleanup(): void {
    if (this.patched && this.original) {
      this.patched.sendCommand = this.original;
      this.patched[PATCHED] = false;
    }
    this.patched = null;
    this.original = null;
  }

  /** Monkey-patch `client.sendCommand` to time + record each command. No-op when
   *  the client lacks `sendCommand` or is already wrapped. */
  private wrap(ctx: WatcherContext, candidate: unknown): void {
    if (!hasSendCommand(candidate)) return;

    const client = candidate;
    if (client[PATCHED]) return;
    client[PATCHED] = true;

    const watcher = this;
    const original = client.sendCommand.bind(client);
    this.patched = client;
    this.original = original;

    client.sendCommand = function patchedSendCommand(
      command: RedisCommandLike,
      ...rest: unknown[]
    ): unknown {
      const startedAt = now();
      const result = original(command, ...rest);
      if (isThenable(result)) {
        const finalize = (): void => {
          watcher.safeRecord(ctx, command, now() - startedAt);
        };
        result.then(finalize, finalize);
      } else {
        watcher.safeRecord(ctx, command, null);
      }
      return result;
    };
  }

  /** Build + record a redis entry, swallowing any failure so a telescope error
   *  can never alter the command's outcome. */
  private safeRecord(
    ctx: WatcherContext,
    command: RedisCommandLike,
    durationMs: number | null,
  ): void {
    try {
      const name =
        typeof command.name === 'string' ? command.name.toUpperCase() : String(command.name ?? '');
      const args = Array.isArray(command.args) ? command.args : [];
      const input: RecordInput = {
        type: EntryType.Redis,
        familyHash: `redis:${name}`,
        tags: ['redis', `redis:${name}`],
        content: { command: name, args, durationMs },
      };
      ctx.record(input);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      console.error(`RedisCommandWatcher: failed to record redis command: ${message}`);
    }
  }
}
