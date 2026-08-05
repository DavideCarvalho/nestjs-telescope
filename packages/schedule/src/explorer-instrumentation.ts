// packages/schedule/src/explorer-instrumentation.ts
import 'reflect-metadata';
import { createRequire } from 'node:module';
import { ScheduleModule } from '@nestjs/schedule';

/**
 * The seam that makes `@nestjs/schedule` runs observable, and WHY it is this one.
 *
 * `ScheduleExplorer.lookupSchedulers` reads the handler ONCE, at the explorer's
 * own `onModuleInit`:
 *
 *     const methodRef = instance[key];
 *     const cronFn = this.wrapFunctionInTryCatchBlocks(methodRef, instance);
 *     this.schedulerOrchestrator.addCron(cronFn, cronMetadata);
 *
 * From then on the orchestrator owns that closure; the prototype is never read
 * again. So replacing the method on the provider's prototype at
 * `onApplicationBootstrap` — where Telescope registers watchers — cannot affect
 * a timer-driven run, and importing Telescope "first" does not change it either
 * (measured: a `@Cron` firing every second for ten seconds produced zero
 * entries). Moving the registrar to `onModuleInit` does not fix it: module init
 * order is not the host's to choose.
 *
 * `wrapFunctionInTryCatchBlocks(methodRef, instance)` is the last point at which
 * the RAW handler is still in the framework's hands, and it is the seam used
 * here — patched from the watcher's constructor, which runs while the host is
 * still building its module metadata and therefore before every explorer.
 *
 * Two properties make this seam the right one rather than merely the earliest:
 *
 *  - **The decorator metadata is never at risk.** `SCHEDULER_TYPE`,
 *    `SCHEDULER_NAME` and `SCHEDULE_*_OPTIONS` are read off the ORIGINAL
 *    `methodRef` before this call, and the scheduling decision is made from
 *    them. Nothing Telescope returns can stop a task from being scheduled —
 *    which is the failure mode that would turn a blind spot into a broken cron.
 *    (The wrapper still carries every metadata key across, so a future version
 *    that reads them later finds them.)
 *  - **The raw throw is still visible.** Wrapping any later — at
 *    `SchedulerOrchestrator.addCron`, say — would sit OUTSIDE the framework's
 *    own try/catch, which logs the error and swallows it, and no exception entry
 *    could ever be produced.
 *
 * The runner is bound late (at `register()`), looked up per call, and lives on
 * the explorer INSTANCE, so two Nest apps in one process never cross-record.
 */

/** A scheduled handler, loosened to what we forward blindly. */
export type ScheduledFn = (...args: unknown[]) => unknown;

/** Run one scheduled tick: `invoke()` calls the real handler on its instance. */
export type ScheduleRunner = (methodRef: ScheduledFn, invoke: () => Promise<unknown>) => unknown;

/** The one `ScheduleExplorer` method we rely on. */
interface ExplorerHost {
  wrapFunctionInTryCatchBlocks(methodRef: ScheduledFn, instance: unknown): ScheduledFn;
}

interface ExplorerClass {
  new (...args: never[]): ExplorerHost;
  prototype: ExplorerHost;
}

interface HostState {
  /** Set by the watcher at register(); null means "call straight through". */
  runner: ScheduleRunner | null;
  /** Handlers wrapped so far — the ordering proof read by register(). */
  wraps: number;
}

/** The outcome of patching the seam, reported at boot when it failed. */
export interface ExplorerInstrumentation {
  readonly installed: boolean;
  /** Human-readable reason the seam is unavailable, for the boot warning. */
  readonly reason: string | null;
  /** The class to resolve from the host's DI container, when installed. */
  readonly explorerClass: ExplorerClass | null;
  /** Our patched wrapper factory, so register() can prove the app has OURS. */
  readonly wrapFunction: ExplorerHost['wrapFunctionInTryCatchBlocks'] | null;
}

const STATE = Symbol.for('@dudousxd/nestjs-telescope:schedule-explorer-state');
const INSTRUMENTED = Symbol.for('@dudousxd/nestjs-telescope:schedule-instrumented');

let outcome: ExplorerInstrumentation | null = null;

function isExplorerHost(value: unknown): value is ExplorerHost {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'wrapFunctionInTryCatchBlocks') === 'function';
}

/** Structural, not by name: the explorer is the provider that both discovers
 *  scheduled methods and wraps them. */
function isExplorerClass(value: unknown): value is ExplorerClass {
  if (typeof value !== 'function') return false;
  const prototype: unknown = Reflect.get(value, 'prototype');
  if (!isExplorerHost(prototype)) return false;
  return (
    typeof Reflect.get(prototype, 'lookupSchedulers') === 'function' &&
    typeof Reflect.get(prototype, 'explore') === 'function'
  );
}

function isHostState(value: unknown): value is HostState {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'wraps') === 'number' && 'runner' in value;
}

/** The state bag for one host object, created on first use. */
function stateOf(host: object): HostState {
  const existing: unknown = Reflect.get(host, STATE);
  if (isHostState(existing)) return existing;
  const created: HostState = { runner: null, wraps: 0 };
  Object.defineProperty(host, STATE, { value: created, configurable: true, writable: true });
  return created;
}

/** The installed `@nestjs/schedule` version, for the "not instrumented" warning. */
function scheduleVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg: unknown = require('@nestjs/schedule/package.json');
    if (typeof pkg === 'object' && pkg !== null) {
      const version: unknown = Reflect.get(pkg, 'version');
      if (typeof version === 'string') return version;
    }
    return 'unknown version';
  } catch {
    return 'unknown version';
  }
}

/**
 * Carry every decorator metadata key from the handler onto the wrapper.
 *
 * Not needed by `@nestjs/schedule` 4.x — it reads `SCHEDULER_TYPE` and friends
 * from the original handler before this wrapper exists — but a wrapper that
 * silently drops them is how an instrumentation bug becomes a task that is
 * never scheduled at all, which is strictly worse than not seeing it run.
 * Copying is cheap; losing a cron is not.
 */
function copyMetadata(from: ScheduledFn, to: ScheduledFn): void {
  try {
    for (const key of Reflect.getMetadataKeys(from)) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, from), to);
    }
  } catch {
    // Metadata copying is belt-and-braces; never let it break scheduling.
  }
}

/**
 * Wrap one scheduled handler so every tick runs through the active runner.
 * Exported so the unit tests can drive the exact function the explorer builds
 * without standing up a whole Nest application.
 */
export function instrumentScheduledMethod(host: object, methodRef: ScheduledFn): ScheduledFn {
  stateOf(host).wraps++;
  const instrumented = function telescopeScheduled(this: unknown, ...args: unknown[]): unknown {
    const runner = stateOf(host).runner;
    if (!runner) return methodRef.apply(this, args);
    // The arrow keeps `this`, so the handler is called on exactly the instance
    // `@nestjs/schedule` bound it to.
    return runner(methodRef, async () => methodRef.apply(this, args));
  };
  copyMetadata(methodRef, instrumented);
  Object.defineProperty(instrumented, INSTRUMENTED, { value: true, configurable: true });
  return instrumented;
}

/** Is this the function Telescope handed the scheduler? */
export function isInstrumentedScheduledMethod(value: unknown): boolean {
  if (typeof value !== 'function') return false;
  return Reflect.get(value, INSTRUMENTED) === true;
}

/** Patch `ScheduleExplorer.prototype.wrapFunctionInTryCatchBlocks`, once. */
export function installExplorerInstrumentation(): ExplorerInstrumentation {
  if (outcome) return outcome;
  outcome = install();
  return outcome;
}

function install(): ExplorerInstrumentation {
  const explorerClass = findExplorerClass();
  if (!explorerClass) {
    return {
      installed: false,
      reason: `@nestjs/schedule ${scheduleVersion()} exposes no ScheduleExplorer.wrapFunctionInTryCatchBlocks seam`,
      explorerClass: null,
      wrapFunction: null,
    };
  }
  const prototype = explorerClass.prototype;
  const original = prototype.wrapFunctionInTryCatchBlocks;

  function wrapFunctionInTryCatchBlocks(
    this: ExplorerHost,
    methodRef: ScheduledFn,
    instance: unknown,
  ): ScheduledFn {
    // Telescope's wrapper goes INSIDE the framework's try/catch: the throw
    // reaches us first (so it can open an exception family) and then reaches
    // the framework's own handler exactly as it would have without us. State is
    // keyed on the explorer INSTANCE, so each Nest app records into its own.
    return original.call(this, instrumentScheduledMethod(this, methodRef), instance);
  }

  prototype.wrapFunctionInTryCatchBlocks = wrapFunctionInTryCatchBlocks;
  return {
    installed: true,
    reason: null,
    explorerClass,
    wrapFunction: wrapFunctionInTryCatchBlocks,
  };
}

/**
 * Find `ScheduleExplorer` without importing it: it is not part of the package's
 * public entry point, and a deep `dist/` import would be a path that changes
 * between versions. `ScheduleModule.forRoot()` is a pure function that returns
 * the module's provider list, so calling it here has no effect on the host's
 * own `forRoot()` call.
 */
function findExplorerClass(): ExplorerClass | null {
  try {
    const dynamicModule: unknown = ScheduleModule.forRoot();
    if (typeof dynamicModule !== 'object' || dynamicModule === null) return null;
    const providers: unknown = Reflect.get(dynamicModule, 'providers');
    if (!Array.isArray(providers)) return null;
    for (const provider of providers) {
      if (isExplorerClass(provider)) return provider;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Point a host's seam at `runner` and report how many handlers it had already
 * wrapped. A non-zero count is the proof of ordering: those wraps happened at
 * the explorer's `onModuleInit`, strictly before this call at
 * `onApplicationBootstrap`.
 */
export function bindScheduleRunner(host: object, runner: ScheduleRunner): number {
  const state = stateOf(host);
  state.runner = runner;
  return state.wraps;
}

/** Detach the runner (the app is going away); the seam calls straight through. */
export function unbindScheduleRunner(host: object): void {
  stateOf(host).runner = null;
}
