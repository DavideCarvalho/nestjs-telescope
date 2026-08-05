// packages/bullmq/src/processor-instrumentation.spec.ts
//
// The seam itself: is it patched, is it patched EARLY ENOUGH, and does the
// wrapper it produces leave the host's behaviour alone.
//
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BullMqJobWatcher } from './bullmq-job.watcher.js';
import {
  bindJobRunner,
  installProcessorInstrumentation,
  instrumentProcessor,
  isInstrumentedProcessor,
  unbindJobRunner,
} from './processor-instrumentation.js';

/** Call a value the framework would call, without pretending to know its type. */
function invoke(fn: unknown, ...args: unknown[]): Promise<unknown> {
  if (typeof fn !== 'function') throw new Error('expected a function');
  return Promise.resolve(fn(...args));
}

describe('processor instrumentation', () => {
  it('patches ProcessorDecoratorService in the installed @nestjs/bullmq', () => {
    const outcome = installProcessorInstrumentation();
    expect(outcome.installed).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.serviceClass?.name).toBe('ProcessorDecoratorService');
    expect(typeof outcome.decorate).toBe('function');
  });

  it('is idempotent — a second watcher does not stack a second wrapper', () => {
    const first = installProcessorInstrumentation();
    const second = installProcessorInstrumentation();
    expect(second.decorate).toBe(first.decorate);
  });

  // THE regression test. Constructing the watcher is the only thing that has
  // happened here: no Nest application, no lifecycle hook, no register(). If
  // someone moves instrumentation back into register() — which the registrar
  // calls at onApplicationBootstrap, long after BullExplorer bound
  // instance['process'] at onModuleInit — this fails.
  it('is in place on the decorator prototype as soon as a watcher is constructed', () => {
    const outcome = installProcessorInstrumentation();
    const prototype = outcome.serviceClass?.prototype;
    expect(prototype).toBeDefined();

    new BullMqJobWatcher();

    expect(prototype?.decorate).toBe(outcome.decorate);
  });

  it('returns an instrumented processor from decorate(), and marks it as such', () => {
    const outcome = installProcessorInstrumentation();
    const host = { decorate: outcome.decorate };
    const raw = async (): Promise<string> => 'ok';

    const decorated: unknown = host.decorate?.(raw);

    expect(isInstrumentedProcessor(raw)).toBe(false);
    expect(isInstrumentedProcessor(decorated)).toBe(true);
    expect(isInstrumentedProcessor(undefined)).toBe(false);
  });

  it('passes the job and the token straight through to the runner', async () => {
    const host = {};
    const seen: unknown[][] = [];
    const wrapped = instrumentProcessor(host, (...args: unknown[]) => {
      seen.push(args);
      return 'ok';
    });
    const jobs: unknown[] = [];
    bindJobRunner(host, (job, run) => {
      jobs.push(job);
      return run();
    });

    await expect(invoke(wrapped, { id: '1' }, 'token-9')).resolves.toBe('ok');
    expect(jobs).toEqual([{ id: '1' }]);
    expect(seen).toEqual([[{ id: '1' }, 'token-9']]);
  });

  it('calls straight through once the runner is unbound', async () => {
    const host = {};
    let ran = 0;
    let processed = 0;
    const wrapped = instrumentProcessor(host, () => {
      processed++;
      return 'ok';
    });
    bindJobRunner(host, (_job, run) => {
      ran++;
      return run();
    });
    await invoke(wrapped, {});
    unbindJobRunner(host);
    await invoke(wrapped, {});

    expect(ran).toBe(1);
    expect(processed).toBe(2); // the job itself always runs
  });

  it('turns a synchronous throw in the processor into a rejection the runner sees', async () => {
    const host = {};
    const wrapped = instrumentProcessor(host, () => {
      throw new Error('sync boom');
    });
    const seen: unknown[] = [];
    bindJobRunner(host, async (_job, run) => {
      try {
        return await run();
      } catch (error) {
        seen.push(error);
        throw error;
      }
    });

    await expect(invoke(wrapped, {})).rejects.toThrow('sync boom');
    expect(seen).toHaveLength(1);
  });

  it('counts the wraps a host has seen, which is how register() proves ordering', () => {
    const host = {};
    instrumentProcessor(host, () => 'a');
    instrumentProcessor(host, () => 'b');
    expect(bindJobRunner(host, (_job, run) => run())).toBe(2);
  });
});
