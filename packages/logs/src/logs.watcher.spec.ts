// packages/logs/src/logs.watcher.spec.ts
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTelescopeLogSink } from './log-sink.js';
import { LogsWatcher } from './logs.watcher.js';
import { TelescopeConsoleLogger } from './telescope-console.logger.js';

interface Harness {
  ctx: WatcherContext;
  recorded: RecordInput[];
}

function makeHarness(options: { recordThrows?: boolean } = {}): Harness {
  const recorded: RecordInput[] = [];
  const ctx: WatcherContext = {
    record: (input) => {
      if (options.recordThrows) throw new Error('recorder boom');
      recorded.push(input);
    },
    runInBatch: async <T>(_origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => fn(),
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: { get: () => undefined } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded };
}

/** A logger that suppresses console output so test runs stay quiet. */
function quietLogger(): TelescopeConsoleLogger {
  const logger = new TelescopeConsoleLogger();
  logger.setLogLevels([]);
  return logger;
}

const PATCHED = Symbol.for('@dudousxd/nestjs-telescope:loggerPatched');
const STATICS_PATCHED = Symbol.for('@dudousxd/nestjs-telescope:loggerStaticsPatched');
const LEVELS = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;

/** Both the prototype and statics patches are process-wide idempotent via
 *  `Symbol.for` markers. Tests mutate the real `Logger.prototype` AND the real
 *  `Logger` class object, so snapshot the originals and both markers before each
 *  test and restore them after — otherwise the first test to patch would poison
 *  every later one. */
const originalMethods = new Map<string, unknown>();
const originalStatics = new Map<string, unknown>();

beforeEach(() => {
  const prototype = Logger.prototype as unknown as Record<string, unknown>;
  const statics = Logger as unknown as Record<string, unknown>;
  for (const level of LEVELS) {
    originalMethods.set(level, prototype[level]);
    originalStatics.set(level, statics[level]);
  }
  // Silence the real console for instance-logger calls during these tests.
  Logger.overrideLogger(false);
});

afterEach(() => {
  setTelescopeLogSink(null);
  const prototype = Logger.prototype as unknown as Record<string, unknown> & {
    [PATCHED]?: boolean;
  };
  const statics = Logger as unknown as Record<string, unknown> & {
    [STATICS_PATCHED]?: boolean;
  };
  for (const level of LEVELS) {
    const original = originalMethods.get(level);
    if (original === undefined) delete prototype[level];
    else prototype[level] = original;
    const originalStatic = originalStatics.get(level);
    if (originalStatic === undefined) delete statics[level];
    else statics[level] = originalStatic;
  }
  delete prototype[PATCHED];
  delete statics[STATICS_PATCHED];
  Logger.overrideLogger(true);
  vi.restoreAllMocks();
});

describe('LogsWatcher', () => {
  it('has type "log"', () => {
    expect(new LogsWatcher({ autoPatch: false }).type).toBe('log');
  });

  describe('explicit TelescopeConsoleLogger sink', () => {
    it('records a Log entry per log call with level, message and context', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher({ autoPatch: false }).register(ctx);
      const logger = quietLogger();

      logger.log('hello world', 'MyService');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.type).toBe('log');
      expect(recorded[0]!.content).toEqual({
        level: 'log',
        message: 'hello world',
        context: 'MyService',
      });
    });

    it('captures every log level', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher({ autoPatch: false }).register(ctx);
      const logger = quietLogger();

      logger.log('l', 'Ctx');
      logger.error('e', undefined, 'Ctx');
      logger.warn('w', 'Ctx');
      logger.debug('d', 'Ctx');
      logger.verbose('v', 'Ctx');

      expect(recorded.map((entry) => (entry.content as { level: string }).level)).toEqual([
        'log',
        'error',
        'warn',
        'debug',
        'verbose',
      ]);
    });

    it('records context null when none is supplied', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher({ autoPatch: false }).register(ctx);
      const logger = quietLogger();

      logger.log('no context');

      expect(recorded[0]!.content).toMatchObject({ context: null });
    });

    it('skips Telescope-internal contexts', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher({ autoPatch: false }).register(ctx);
      const logger = quietLogger();

      logger.log('internal', 'TelescopeService');
      logger.log('recorder', 'Recorder');
      logger.log('kept', 'AppService');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toMatchObject({ context: 'AppService' });
    });

    it('is a no-op when the sink is not wired', () => {
      const { recorded } = makeHarness();
      // No register() call → sink stays null.
      const logger = quietLogger();

      logger.log('orphan', 'AppService');

      expect(recorded).toHaveLength(0);
    });

    it('never breaks logging when ctx.record throws', () => {
      const { ctx } = makeHarness({ recordThrows: true });
      new LogsWatcher({ autoPatch: false }).register(ctx);
      const logger = quietLogger();

      expect(() => logger.log('boom', 'AppService')).not.toThrow();
    });

    it('stops recording after cleanup', () => {
      const { ctx, recorded } = makeHarness();
      const watcher = new LogsWatcher({ autoPatch: false });
      watcher.register(ctx);
      watcher.cleanup();
      const logger = quietLogger();

      logger.log('after', 'AppService');

      expect(recorded).toHaveLength(0);
    });

    it('wires the sink exactly once across repeated register calls', () => {
      const { ctx, recorded } = makeHarness();
      const watcher = new LogsWatcher({ autoPatch: false });
      watcher.register(ctx);
      watcher.register(ctx);
      const logger = quietLogger();

      logger.log('once', 'AppService');

      expect(recorded).toHaveLength(1);
    });
  });

  describe('auto-patch mode (default, zero-config)', () => {
    it('records through a `new Logger(Ctx).log(msg)` facade call', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);

      new Logger('MyService').log('hello facade');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.type).toBe('log');
      expect(recorded[0]!.content).toEqual({
        level: 'log',
        message: 'hello facade',
        context: 'MyService',
      });
    });

    it('still invokes the original logger behavior (host output preserved)', () => {
      const { ctx } = makeHarness();
      const original: (...args: unknown[]) => void = Logger.prototype.log;
      const spy = vi.fn();
      Logger.prototype.log = function spied(this: unknown, ...args: unknown[]): void {
        spy(...args);
        original.apply(this, args);
      };

      new LogsWatcher().register(ctx);
      // Context comes from `this.context`, not an arg — the facade forwards only
      // the message it was given. The point is the original still runs.
      new Logger('Svc').log('to original');

      expect(spy).toHaveBeenCalledWith('to original');
    });

    it('captures every level including fatal when present', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);
      const logger = new Logger('Ctx');

      logger.log('l');
      logger.error('e');
      logger.warn('w');
      logger.debug('d');
      logger.verbose('v');
      if (typeof logger.fatal === 'function') logger.fatal('f');

      const levels = recorded.map((entry) => (entry.content as { level: string }).level);
      expect(levels).toEqual(
        typeof logger.fatal === 'function'
          ? ['log', 'error', 'warn', 'debug', 'verbose', 'fatal']
          : ['log', 'error', 'warn', 'debug', 'verbose'],
      );
    });

    it('tags error-level logs so keepErrors can retain them', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);

      new Logger('Svc').error('boom');

      expect(recorded[0]!.tags).toEqual(['log', 'log:error']);
    });

    it('honors a trailing context override and falls back to the instance context', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);

      new Logger('Instance').log('m', 'Override');
      new Logger('Instance').log('n');

      expect(recorded[0]!.content).toMatchObject({ context: 'Override' });
      expect(recorded[1]!.content).toMatchObject({ context: 'Instance' });
    });

    it('stringifies non-string messages without throwing', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);

      new Logger('Svc').log({ a: 1 });

      expect(recorded[0]!.content).toMatchObject({ message: '{"a":1}' });
    });

    it('skips Telescope-internal contexts on the facade path', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);

      new Logger('Recorder').log('internal');
      new Logger('AppService').log('kept');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toMatchObject({ context: 'AppService' });
    });

    it('does not infinitely loop when ctx.record throws (re-entrancy guard)', () => {
      const { ctx } = makeHarness({ recordThrows: true });
      new LogsWatcher().register(ctx);

      // The failed record logs an error via `new Logger(LogsWatcher.name)`, which
      // re-enters the patched method; the re-entrancy guard must stop the loop.
      expect(() => new Logger('Svc').log('boom')).not.toThrow();
    });

    it('patches the prototype exactly once across two watchers (idempotent)', () => {
      const first = makeHarness();
      new LogsWatcher().register(first.ctx);
      // A second watcher (or second package copy) must not double-wrap.
      new LogsWatcher().register(makeHarness().ctx);

      new Logger('Svc').log('once');

      // Records once on the first watcher's ctx; no second wrapper layer means
      // the second watcher's ctx is never reached and no double-record happens.
      expect(first.recorded).toHaveLength(1);
    });
  });

  describe('auto-patch mode — static Logger.* calls', () => {
    it('records through a `Logger.log(msg, ctx)` static call', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);

      Logger.log('hello static', 'StaticService');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.type).toBe('log');
      expect(recorded[0]!.content).toEqual({
        level: 'log',
        message: 'hello static',
        context: 'StaticService',
      });
    });

    it('records a static `Logger.error(msg, stack, ctx)` with level and context', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);

      Logger.error('static boom', 'trace', 'StaticService');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toEqual({
        level: 'error',
        message: 'static boom',
        context: 'StaticService',
      });
      // Error level is tagged so keepErrors tail-sampling retains it.
      expect(recorded[0]!.tags).toEqual(['log', 'log:error']);
    });

    it('records context null when the static call supplies none', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);

      Logger.log('no static context');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toMatchObject({ context: null });
    });

    it('skips Telescope-internal contexts on the static path', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);

      Logger.log('internal', 'Recorder');
      Logger.log('kept', 'AppService');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toMatchObject({ context: 'AppService' });
    });

    it('still invokes the original static behavior (host output preserved)', () => {
      const { ctx } = makeHarness();
      const original: (...args: unknown[]) => void = Logger.log;
      const spy = vi.fn();
      // `this` must remain the Logger class so the original reads staticInstanceRef.
      Logger.log = function spiedStatic(this: unknown, ...args: unknown[]): void {
        spy(...args);
        original.apply(this, args);
      };

      new LogsWatcher().register(ctx);
      Logger.log('to original static', 'Svc');

      expect(spy).toHaveBeenCalledWith('to original static', 'Svc');
    });

    it('does not infinitely loop when ctx.record throws on a static call', () => {
      const { ctx } = makeHarness({ recordThrows: true });
      new LogsWatcher().register(ctx);

      // The failed record logs an error via `new Logger(LogsWatcher.name)`; the
      // shared re-entrancy guard must stop the record→log→record loop.
      expect(() => Logger.log('boom', 'Svc')).not.toThrow();
    });

    it('patches the statics exactly once across two watchers (idempotent)', () => {
      const first = makeHarness();
      new LogsWatcher().register(first.ctx);
      // A second watcher (or second package copy) must not double-wrap.
      new LogsWatcher().register(makeHarness().ctx);

      Logger.log('once', 'Svc');

      expect(first.recorded).toHaveLength(1);
    });
  });

  describe('exactly-once across both patched paths', () => {
    // Instance and static calls are disjoint paths in Nest 11 (an instance
    // log() delegates to localInstance, a static Logger.log() to
    // staticInstanceRef — both ConsoleLoggers, neither routing through the
    // other). Patching both must therefore record each logical call exactly
    // once, never twice.
    it('records one instance `new Logger(X).log(m)` call exactly once', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);

      new Logger('X').log('m');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toEqual({ level: 'log', message: 'm', context: 'X' });
    });

    it('records one static `Logger.log(m, X)` call exactly once', () => {
      const { ctx, recorded } = makeHarness();
      new LogsWatcher().register(ctx);

      Logger.log('m', 'X');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toEqual({ level: 'log', message: 'm', context: 'X' });
    });
  });

  describe('explicit + auto-patch coexistence', () => {
    it('records a facade call exactly once even with TelescopeConsoleLogger behind it', () => {
      const { ctx, recorded } = makeHarness();
      // Both paths active: auto-patch on AND a TelescopeConsoleLogger installed
      // as the facade's underlying logger.
      const watcher = new LogsWatcher({ autoPatch: true });
      watcher.register(ctx);
      const consoleLogger = quietLogger();
      Logger.overrideLogger(consoleLogger);

      // A facade call hits the patched prototype, whose original delegates to the
      // TelescopeConsoleLogger sink — the re-entrancy flag must dedupe to one.
      new Logger('AppService').log('single');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toMatchObject({
        level: 'log',
        message: 'single',
        context: 'AppService',
      });
    });
  });
});
