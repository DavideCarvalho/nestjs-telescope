// packages/inertia-watcher/src/inertia.watcher.spec.ts
//
// The watcher subscribes to the `nestjs-inertia:render` diagnostics channel that
// `@dudousxd/nestjs-inertia` publishes to (one event per response). We exercise it
// against the real `node:diagnostics_channel` and a fake `WatcherContext`.
//
import diagnostics_channel from 'node:diagnostics_channel';
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  redactBounded,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { afterEach, describe, expect, it } from 'vitest';
import type { InertiaContent, InertiaRenderDiagnostic } from './inertia-content.js';
import { buildInertiaContent } from './inertia-content.js';
import { InertiaWatcher } from './inertia.watcher.js';

const INERTIA_CHANNEL = 'nestjs-inertia:render';

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

function makeDiagnostic(overrides: Partial<InertiaRenderDiagnostic> = {}): InertiaRenderDiagnostic {
  return {
    v: 1,
    component: 'Dashboard',
    url: '/dashboard',
    method: 'GET',
    isInertia: true,
    isPartial: false,
    partial: { only: [], except: [], reset: [], resetOnce: [] },
    props: {
      sharedKeys: [],
      finalKeys: ['user'],
      deferred: {},
      merge: [],
      deepMerge: [],
      matchPropsOn: {},
      optionalKeys: [],
      onceKeys: [],
      excludedKeys: [],
    },
    resolvedProps: { user: { name: 'Ada' } },
    assetVersion: 'v1',
    versionMismatch: false,
    clientVersion: null,
    encryptHistory: false,
    clearHistory: false,
    statusCode: 200,
    pageBytes: 42,
    ssr: false,
    ...overrides,
  };
}

function publish(payload: unknown): void {
  diagnostics_channel.channel(INERTIA_CHANNEL).publish(payload);
}

// Track watchers so each test's subscription is torn down (channel is process-global).
const created: InertiaWatcher[] = [];
function newWatcher(): InertiaWatcher {
  const w = new InertiaWatcher();
  created.push(w);
  return w;
}
afterEach(() => {
  for (const w of created.splice(0)) w.cleanup();
});

describe('InertiaWatcher', () => {
  it('has type "inertia"', () => {
    expect(newWatcher().type).toBe('inertia');
  });

  it('subscribes on register (flips hasSubscribers) and unsubscribes on cleanup', () => {
    const channel = diagnostics_channel.channel(INERTIA_CHANNEL);
    const { ctx } = makeHarness();
    const watcher = new InertiaWatcher();

    expect(channel.hasSubscribers).toBe(false);
    watcher.register(ctx);
    expect(channel.hasSubscribers).toBe(true);
    watcher.cleanup();
    expect(channel.hasSubscribers).toBe(false);
  });

  it('records one inertia entry per published diagnostic with mapped content/tags/familyHash', () => {
    const { ctx, recorded } = makeHarness();
    newWatcher().register(ctx);

    publish(makeDiagnostic());

    expect(recorded).toHaveLength(1);
    const entry = recorded[0]!;
    expect(entry.type).toBe('inertia');
    expect(entry.familyHash).toBe('inertia:Dashboard');
    expect(entry.durationMs).toBeNull();
    expect(entry.tags).toContain('inertia');
    expect(entry.tags).toContain('inertia:component:Dashboard');
    const content = entry.content as InertiaContent;
    expect(content.component).toBe('Dashboard');
    expect(content.method).toBe('GET');
    expect(content.statusCode).toBe(200);
    expect(content.resolvedProps).toEqual({ user: { name: 'Ada' } });
  });

  it('adds the partial / version-mismatch / deferred / merge tags when applicable', () => {
    const { ctx, recorded } = makeHarness();
    newWatcher().register(ctx);

    publish(
      makeDiagnostic({
        isPartial: true,
        versionMismatch: true,
        props: {
          ...makeDiagnostic().props,
          deferred: { default: ['stats'] },
          merge: ['list'],
        },
      }),
    );

    const tags = recorded[0]!.tags ?? [];
    expect(tags).toContain('inertia:partial');
    expect(tags).toContain('inertia:version-mismatch');
    expect(tags).toContain('inertia:deferred');
    expect(tags).toContain('inertia:merge');
  });

  it('subscribes exactly once across repeated register calls', () => {
    const { ctx, recorded } = makeHarness();
    const watcher = newWatcher();
    watcher.register(ctx);
    watcher.register(ctx);

    publish(makeDiagnostic());

    expect(recorded).toHaveLength(1);
  });

  it('drops malformed / wrong-version payloads without throwing or recording', () => {
    const { ctx, recorded } = makeHarness();
    newWatcher().register(ctx);

    expect(() => publish({ v: 99, component: 'X' })).not.toThrow();
    expect(() => publish(null)).not.toThrow();
    expect(() => publish({})).not.toThrow();
    expect(() => publish('nope')).not.toThrow();

    expect(recorded).toHaveLength(0);
  });

  it('swallows a throwing recorder so a render is never broken', () => {
    const { ctx } = makeHarness({ recordThrows: true });
    newWatcher().register(ctx);

    expect(() => publish(makeDiagnostic())).not.toThrow();
  });

  it('records nothing after cleanup', () => {
    const { ctx, recorded } = makeHarness();
    const watcher = new InertiaWatcher();
    watcher.register(ctx);
    watcher.cleanup();

    publish(makeDiagnostic());

    expect(recorded).toHaveLength(0);
  });
});

describe('buildInertiaContent — passes resolvedProps by reference for the Recorder to clip', () => {
  it('keeps the same object reference (no clone/stringify here)', () => {
    const resolvedProps = { user: { name: 'Ada' } };
    const input = buildInertiaContent(makeDiagnostic({ resolvedProps }));
    expect((input.content as InertiaContent).resolvedProps).toBe(resolvedProps);
  });

  it('the Recorder budget masks secrets and truncates oversized trees downstream', () => {
    const bigArray = Array.from({ length: 5_000 }, (_v, i) => i);
    const resolvedProps = { password: 'hunter2', list: bigArray };
    const input = buildInertiaContent(makeDiagnostic({ resolvedProps }));

    const { value, truncated } = redactBounded(input.content, {});
    const out = value as { resolvedProps: { password: unknown; list: unknown[] } };

    expect(out.resolvedProps.password).toBe('[REDACTED]');
    expect((out.resolvedProps.list as unknown[]).length).toBeLessThan(bigArray.length);
    expect(truncated).toBe(true);
  });
});

describe('InertiaWatcher — correlation', () => {
  it('records inside the surrounding batch scope (synchronous publish)', async () => {
    const { ctx, recorded } = makeHarness();
    newWatcher().register(ctx);

    // The publish runs synchronously on the caller's stack, so a record issued
    // from within a runInBatch scope lands while that scope is active.
    await ctx.runInBatch('http', async () => {
      publish(makeDiagnostic());
    });

    expect(recorded).toHaveLength(1);
    expect((recorded[0]!.content as InertiaContent).component).toBe('Dashboard');
  });
});
