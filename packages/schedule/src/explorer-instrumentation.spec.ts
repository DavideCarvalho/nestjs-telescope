// packages/schedule/src/explorer-instrumentation.spec.ts
//
// The seam itself: is it patched, is it patched EARLY ENOUGH, and does the
// wrapper it produces keep `@nestjs/schedule`'s own contract intact.
//
import 'reflect-metadata';
import { Cron } from '@nestjs/schedule';
import { describe, expect, it } from 'vitest';
import {
  bindScheduleRunner,
  installExplorerInstrumentation,
  instrumentScheduledMethod,
  isInstrumentedScheduledMethod,
  unbindScheduleRunner,
} from './explorer-instrumentation.js';
import { ScheduleWatcher } from './schedule.watcher.js';

/** Call a value the framework would call, without pretending to know its type. */
function invoke(fn: unknown, target: unknown, ...args: unknown[]): Promise<unknown> {
  if (typeof fn !== 'function') throw new Error('expected a function');
  return Promise.resolve(fn.apply(target, args));
}

describe('explorer instrumentation', () => {
  it('finds and patches ScheduleExplorer in the installed @nestjs/schedule', () => {
    const outcome = installExplorerInstrumentation();
    expect(outcome.installed).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(typeof outcome.wrapFunction).toBe('function');
    expect(outcome.explorerClass?.name).toBe('ScheduleExplorer');
  });

  it('is idempotent — a second watcher does not stack a second wrapper', () => {
    const first = installExplorerInstrumentation();
    const second = installExplorerInstrumentation();
    expect(second.wrapFunction).toBe(first.wrapFunction);
  });

  // THE regression test. Constructing the watcher is the only thing that has
  // happened here: no Nest application, no lifecycle hook, no register(). If
  // someone moves instrumentation back into register() — which the registrar
  // calls at onApplicationBootstrap, long after ScheduleExplorer closed over
  // instance[key] at its own onModuleInit — this fails.
  it('is in place on the explorer prototype as soon as a watcher is constructed', () => {
    const outcome = installExplorerInstrumentation();
    const prototype = outcome.explorerClass?.prototype;
    expect(prototype).toBeDefined();

    new ScheduleWatcher();

    expect(prototype?.wrapFunctionInTryCatchBlocks).toBe(outcome.wrapFunction);
  });

  it('routes a wrapped handler through the bound runner, on the handler’s instance', async () => {
    class Task {
      public seen: unknown[] = [];
      run(...args: unknown[]): string {
        this.seen = args;
        return 'ok';
      }
    }
    const task = new Task();
    const host = {};
    const wrapped = instrumentScheduledMethod(host, Task.prototype.run);
    const calls: unknown[] = [];
    bindScheduleRunner(host, (methodRef, run) => {
      calls.push(methodRef);
      return run();
    });

    await expect(invoke(wrapped, task, 'a', 'b')).resolves.toBe('ok');
    expect(calls).toEqual([Task.prototype.run]);
    expect(task.seen).toEqual(['a', 'b']);
  });

  it('calls straight through once the runner is unbound', async () => {
    class Task {
      calls = 0;
      run(): string {
        this.calls++;
        return 'ok';
      }
    }
    const task = new Task();
    const host = {};
    const wrapped = instrumentScheduledMethod(host, Task.prototype.run);
    let ran = 0;
    bindScheduleRunner(host, (_methodRef, run) => {
      ran++;
      return run();
    });
    await invoke(wrapped, task);
    unbindScheduleRunner(host);
    await invoke(wrapped, task);

    expect(ran).toBe(1);
    expect(task.calls).toBe(2); // the task itself always runs
  });

  // A wrapper that drops SCHEDULER_TYPE / SCHEDULE_CRON_OPTIONS stops the task
  // being scheduled AT ALL — a broken cron is far worse than an unobserved one.
  // 4.x reads them off the original before wrapping, so this is insurance
  // against a version that reads them later; it costs one loop.
  it('carries every decorator metadata key onto the wrapper', () => {
    class Task {
      @Cron('*/5 * * * * *', { name: 'metadata-check' })
      run(): void {}
    }
    const original = Task.prototype.run;
    const wrapped = instrumentScheduledMethod({}, original);

    const keys = Reflect.getMetadataKeys(original);
    expect(keys).toEqual(expect.arrayContaining(['SCHEDULER_TYPE', 'SCHEDULER_NAME']));
    for (const key of keys) {
      expect(Reflect.getMetadata(key, wrapped)).toEqual(Reflect.getMetadata(key, original));
    }
  });

  it('marks its wrapper so a test can tell instrumented from raw', () => {
    const raw = (): string => 'raw';
    expect(isInstrumentedScheduledMethod(raw)).toBe(false);
    expect(isInstrumentedScheduledMethod(instrumentScheduledMethod({}, raw))).toBe(true);
    expect(isInstrumentedScheduledMethod(undefined)).toBe(false);
  });

  it('sits INSIDE @nestjs/schedule’s own try/catch, so the framework still swallows', async () => {
    // The explorer's wrapper is what actually gets scheduled; ours goes inside
    // it. That ordering is what lets the watcher see a raw throw (and open an
    // exception family) while the framework's error handling is unchanged.
    const outcome = installExplorerInstrumentation();
    const prototype = outcome.explorerClass?.prototype;
    if (!prototype) throw new Error('the explorer prototype should have been found');
    const explorer = Object.create(prototype);
    const logged: unknown[] = [];
    Reflect.set(explorer, 'logger', { error: (error: unknown) => logged.push(error) });

    class Task {
      run(): never {
        throw new Error('cron boom');
      }
    }
    const seen: unknown[] = [];
    bindScheduleRunner(explorer, async (_methodRef, run) => {
      try {
        return await run();
      } catch (error) {
        seen.push(error); // Telescope sees the raw throw…
        throw error;
      }
    });

    const scheduled = prototype.wrapFunctionInTryCatchBlocks.call(
      explorer,
      Task.prototype.run,
      new Task(),
    );
    await expect(invoke(scheduled, undefined)).resolves.toBeUndefined(); // …and the framework still swallows it

    expect(seen).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });
});
