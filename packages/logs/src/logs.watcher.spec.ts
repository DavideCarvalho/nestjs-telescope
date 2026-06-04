// packages/logs/src/logs.watcher.spec.ts
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(() => {
  setTelescopeLogSink(null);
});

describe('LogsWatcher', () => {
  it('has type "log"', () => {
    expect(new LogsWatcher().type).toBe('log');
  });

  it('records a Log entry per log call with level, message and context', () => {
    const { ctx, recorded } = makeHarness();
    new LogsWatcher().register(ctx);
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
    new LogsWatcher().register(ctx);
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
    new LogsWatcher().register(ctx);
    const logger = quietLogger();

    logger.log('no context');

    expect(recorded[0]!.content).toMatchObject({ context: null });
  });

  it('skips Telescope-internal contexts', () => {
    const { ctx, recorded } = makeHarness();
    new LogsWatcher().register(ctx);
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

  it('wires the sink exactly once across repeated register calls', () => {
    const { ctx, recorded } = makeHarness();
    const watcher = new LogsWatcher();
    watcher.register(ctx);
    watcher.register(ctx);
    const logger = quietLogger();

    logger.log('once', 'AppService');

    expect(recorded).toHaveLength(1);
  });

  it('never breaks logging when ctx.record throws', () => {
    const { ctx } = makeHarness({ recordThrows: true });
    new LogsWatcher().register(ctx);
    const logger = quietLogger();

    expect(() => logger.log('boom', 'AppService')).not.toThrow();
  });

  it('stops recording after cleanup', () => {
    const { ctx, recorded } = makeHarness();
    const watcher = new LogsWatcher();
    watcher.register(ctx);
    watcher.cleanup();
    const logger = quietLogger();

    logger.log('after', 'AppService');

    expect(recorded).toHaveLength(0);
  });
});
