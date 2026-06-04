// packages/events/src/events.watcher.spec.ts
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, expect, it } from 'vitest';
import { EventsWatcher } from './events.watcher.js';

interface Harness {
  ctx: WatcherContext;
  recorded: RecordInput[];
}

/** Build a WatcherContext whose moduleRef resolves the given emitter (or nothing). */
function makeHarness(resolved: unknown, options: { recordThrows?: boolean } = {}): Harness {
  const recorded: RecordInput[] = [];
  const ctx: WatcherContext = {
    record: (input) => {
      if (options.recordThrows) throw new Error('recorder boom');
      recorded.push(input);
    },
    runInBatch: async <T>(_origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => fn(),
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: {
      get: () => {
        if (resolved === undefined) throw new Error('not found');
        return resolved;
      },
    } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded };
}

describe('EventsWatcher', () => {
  it('has type "event"', () => {
    expect(new EventsWatcher().type).toBe('event');
  });

  it('records an Event entry when an event is emitted', () => {
    const emitter = new EventEmitter2({ wildcard: true });
    const { ctx, recorded } = makeHarness(emitter);
    new EventsWatcher().register(ctx);

    emitter.emit('user.created', { id: 1 });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.type).toBe('event');
    expect(recorded[0]!.content).toEqual({
      name: 'user.created',
      payload: { id: 1 },
      listenerCount: expect.any(Number),
    });
    expect(recorded[0]!.tags).toContain('event:user.created');
  });

  it('records the array of values when several are emitted', () => {
    const emitter = new EventEmitter2({ wildcard: true });
    const { ctx, recorded } = makeHarness(emitter);
    new EventsWatcher().register(ctx);

    emitter.emit('multi', 'a', 'b', 'c');

    expect(recorded[0]!.content).toMatchObject({ name: 'multi', payload: ['a', 'b', 'c'] });
  });

  it('captures multiple distinct event names via the wildcard listener', () => {
    const emitter = new EventEmitter2({ wildcard: true });
    const { ctx, recorded } = makeHarness(emitter);
    new EventsWatcher().register(ctx);

    emitter.emit('one', 1);
    emitter.emit('two', 2);

    expect(recorded.map((entry) => (entry.content as { name: string }).name)).toEqual([
      'one',
      'two',
    ]);
  });

  it('degrades to a no-op when the emitter is absent', () => {
    const { ctx, recorded } = makeHarness(undefined);
    expect(() => new EventsWatcher().register(ctx)).not.toThrow();
    expect(recorded).toHaveLength(0);
  });

  it('degrades to a no-op when the resolved provider has no onAny', () => {
    const { ctx, recorded } = makeHarness({ notAnEmitter: true });
    expect(() => new EventsWatcher().register(ctx)).not.toThrow();
    expect(recorded).toHaveLength(0);
  });

  it('attaches the wildcard listener exactly once across repeated register calls', () => {
    const emitter = new EventEmitter2({ wildcard: true });
    const { ctx, recorded } = makeHarness(emitter);
    const watcher = new EventsWatcher();
    watcher.register(ctx);
    watcher.register(ctx);

    emitter.emit('once', 1);

    expect(recorded).toHaveLength(1);
  });

  it('never breaks emission when ctx.record throws', () => {
    const emitter = new EventEmitter2({ wildcard: true });
    const { ctx } = makeHarness(emitter, { recordThrows: true });
    new EventsWatcher().register(ctx);

    expect(() => emitter.emit('boom', 1)).not.toThrow();
  });

  it('detaches the wildcard listener on cleanup', () => {
    const emitter = new EventEmitter2({ wildcard: true });
    const { ctx, recorded } = makeHarness(emitter);
    const watcher = new EventsWatcher();
    watcher.register(ctx);
    watcher.cleanup();

    emitter.emit('after.cleanup', 1);

    expect(recorded).toHaveLength(0);
  });
});
