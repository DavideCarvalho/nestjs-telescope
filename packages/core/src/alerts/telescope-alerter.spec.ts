// packages/core/src/alerts/telescope-alerter.spec.ts
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { customChannel } from './alert-channel.js';
import type { AlertPayload, AlertRule, ResolvedAlerts } from './alert-rule.js';
import { TelescopeAlerter } from './telescope-alerter.js';

const NOW = 1_000_000_000_000;

function entry(type: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(NOW),
    ...overrides,
  };
}

interface Harness {
  alerter: TelescopeAlerter;
  /** Every payload dispatched to channels, in order. */
  sent: AlertPayload[];
  storage: InMemoryStorageProvider;
  now: () => number;
  setNow: (ms: number) => void;
  dropped: { value: number };
}

function makeAlerter(
  rules: AlertRule[],
  partial: Partial<Omit<ResolvedAlerts, 'channels'>> = {},
): Harness {
  const storage = new InMemoryStorageProvider();
  const sent: AlertPayload[] = [];
  const dropped = { value: 0 };
  let current = NOW;
  const now = () => current;
  const channel = customChannel(async (alert) => {
    sent.push(alert);
  }, 'capture');
  const resolved: ResolvedAlerts = {
    channels: [channel],
    dashboardUrl: null,
    intervalMs: 60_000,
    cooldownMs: 900_000,
    rules,
    ...partial,
  };
  const alerter = new TelescopeAlerter({
    alerts: resolved,
    storage,
    instanceId: 'instance-7',
    droppedCount: () => dropped.value,
    now,
    logger: new Logger('test'),
  });
  function setNow(ms: number): void {
    current = ms;
  }
  return { alerter, sent, storage, now, setNow, dropped };
}

describe('TelescopeAlerter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exception-rate fires at threshold and dispatches the payload shape', async () => {
    const rule: AlertRule = { type: 'exception-rate', window: '5m', threshold: 3 };
    const { alerter, sent, storage } = makeAlerter([rule]);
    await storage.store([entry('exception'), entry('exception'), entry('exception')]);
    await alerter.evaluate();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      rule,
      value: 3,
      threshold: 3,
      instanceId: 'instance-7',
      firedAt: new Date(NOW).toISOString(),
    });
  });

  it('exception-rate does NOT fire under threshold', async () => {
    const { alerter, sent, storage } = makeAlerter([
      { type: 'exception-rate', window: '5m', threshold: 3 },
    ]);
    await storage.store([entry('exception'), entry('exception')]);
    await alerter.evaluate();
    expect(sent).toHaveLength(0);
  });

  it('slow-request-rate counts only requests slower than thresholdMs', async () => {
    const { alerter, sent, storage } = makeAlerter([
      { type: 'slow-request-rate', window: '5m', thresholdMs: 500, count: 2 },
    ]);
    await storage.store([
      entry('request', { durationMs: 600 }),
      entry('request', { durationMs: 800 }),
      entry('request', { durationMs: 100 }),
    ]);
    await alerter.evaluate();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.value).toBe(2);
  });

  it('cooldown suppresses a re-fire then re-allows after it elapses', async () => {
    const rule: AlertRule = { type: 'exception-rate', window: '5m', threshold: 1 };
    const { alerter, sent, storage, setNow } = makeAlerter([rule], { cooldownMs: 10_000 });
    await storage.store([entry('exception')]);
    await alerter.evaluate();
    expect(sent).toHaveLength(1);

    // Within cooldown: suppressed.
    setNow(NOW + 5_000);
    await alerter.evaluate();
    expect(sent).toHaveLength(1);

    // After cooldown: re-allowed.
    setNow(NOW + 11_000);
    await alerter.evaluate();
    expect(sent).toHaveLength(2);
  });

  it('dropped-entries fires on the delta since the previous evaluation', async () => {
    const { alerter, sent, dropped } = makeAlerter([{ type: 'dropped-entries', threshold: 5 }], {
      cooldownMs: 0,
    });
    // Baseline captured in the constructor is 0; bump by 6 → delta 6 >= 5.
    dropped.value = 6;
    await alerter.evaluate();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.value).toBe(6);

    // No new drops → delta 0 → no fire.
    await alerter.evaluate();
    expect(sent).toHaveLength(1);

    // Another burst of 5 → delta 5 → fires again.
    dropped.value = 11;
    await alerter.evaluate();
    expect(sent).toHaveLength(2);
  });

  it("start() schedules an unref'd interval and stop() clears it", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(global, 'setInterval');
    const clearSpy = vi.spyOn(global, 'clearInterval');
    const { alerter } = makeAlerter([{ type: 'dropped-entries', threshold: 1 }]);
    alerter.start();
    const timer = setSpy.mock.results[0]?.value as { unref?: unknown };
    expect(typeof timer.unref).toBe('function');
    alerter.stop();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent (one interval)', () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(global, 'setInterval');
    const { alerter } = makeAlerter([{ type: 'dropped-entries', threshold: 1 }]);
    alerter.start();
    alerter.start();
    expect(setSpy).toHaveBeenCalledTimes(1);
    alerter.stop();
  });

  describe('channel fan-out', () => {
    it('fans a fired alert out to every channel concurrently', async () => {
      const storage = new InMemoryStorageProvider();
      const a: AlertPayload[] = [];
      const b: AlertPayload[] = [];
      const dropped = { value: 0 };
      const alerter = new TelescopeAlerter({
        alerts: {
          channels: [
            customChannel(async (alert) => {
              a.push(alert);
            }, 'a'),
            customChannel(async (alert) => {
              b.push(alert);
            }, 'b'),
          ],
          dashboardUrl: null,
          intervalMs: 60_000,
          cooldownMs: 0,
          rules: [{ type: 'dropped-entries', threshold: 1 }],
        },
        storage,
        instanceId: 'i',
        droppedCount: () => dropped.value,
        now: () => NOW,
        logger: new Logger('test'),
      });
      dropped.value = 5;
      await alerter.evaluate();
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it('isolates a failing channel and still delivers to the others; warns once', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const storage = new InMemoryStorageProvider();
      const good: AlertPayload[] = [];
      const dropped = { value: 0 };
      const alerter = new TelescopeAlerter({
        alerts: {
          channels: [
            customChannel(async () => {
              throw new Error('boom');
            }, 'bad'),
            customChannel(async (alert) => {
              good.push(alert);
            }, 'good'),
          ],
          dashboardUrl: null,
          intervalMs: 60_000,
          cooldownMs: 0,
          rules: [{ type: 'dropped-entries', threshold: 1 }],
        },
        storage,
        instanceId: 'i',
        droppedCount: () => dropped.value,
        now: () => NOW,
        logger: new Logger('test'),
      });
      dropped.value = 5;
      // Two fires: the good channel always delivers; the bad one warns ONCE.
      await expect(alerter.evaluate()).resolves.toBeUndefined();
      dropped.value = 10;
      await alerter.evaluate();
      expect(good).toHaveLength(2);
      const badWarns = warn.mock.calls.filter((c) => String(c[0]).includes("'bad'"));
      expect(badWarns).toHaveLength(1);
    });
  });

  describe('new-exception rule', () => {
    const FIVE_MIN = 5 * 60_000;

    /** Build + store an exception entry (with a request sibling) in one batch. */
    async function storeException(
      storage: InMemoryStorageProvider,
      familyHash: string,
      batchId: string,
      createdAt: number,
    ): Promise<Entry> {
      const exception = entry('exception', {
        id: `ex-${batchId}`,
        batchId,
        familyHash,
        createdAt: new Date(createdAt),
        content: { class: 'TypeError', message: 'boom', stack: 'TypeError: boom\n  at a\n  at b' },
      });
      const request = entry('request', {
        id: `req-${batchId}`,
        batchId,
        durationMs: 1234,
        tags: ['user:42'],
        createdAt: new Date(createdAt),
        content: { method: 'POST', uri: '/checkout', statusCode: 500 },
      });
      await storage.store([exception, request]);
      return exception;
    }

    it('fires on the FIRST occurrence of a new error family', async () => {
      const { alerter, sent, storage } = makeAlerter([{ type: 'new-exception', window: '1h' }]);
      const ex = await storeException(storage, 'fam-A', 'b1', NOW);
      await alerter.evaluateFlush([ex]);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.rule.type).toBe('new-exception');
    });

    it('does NOT re-fire for a repeat within the window', async () => {
      const { alerter, sent, storage } = makeAlerter([{ type: 'new-exception', window: '1h' }]);
      const first = await storeException(storage, 'fam-A', 'b1', NOW);
      await alerter.evaluateFlush([first]);
      const second = await storeException(storage, 'fam-A', 'b2', NOW + 60_000);
      await alerter.evaluateFlush([second]);
      expect(sent).toHaveLength(1);
    });

    it('re-fires after the window elapses', async () => {
      const { alerter, sent, storage, setNow } = makeAlerter(
        [{ type: 'new-exception', window: '5m' }],
        { cooldownMs: 0 },
      );
      const first = await storeException(storage, 'fam-A', 'b1', NOW);
      await alerter.evaluateFlush([first]);
      // Move past the window so the family is "new" again.
      setNow(NOW + FIVE_MIN + 1_000);
      const second = await storeException(storage, 'fam-A', 'b2', NOW + FIVE_MIN + 1_000);
      await alerter.evaluateFlush([second]);
      expect(sent).toHaveLength(2);
    });

    it('respects the per-family cooldown', async () => {
      const { alerter, sent, storage, setNow } = makeAlerter(
        [{ type: 'new-exception', window: '5m' }],
        { cooldownMs: 10 * 60_000 },
      );
      const first = await storeException(storage, 'fam-A', 'b1', NOW);
      await alerter.evaluateFlush([first]);
      expect(sent).toHaveLength(1);
      // Window elapsed (family "new" again) but cooldown has NOT — must suppress.
      setNow(NOW + FIVE_MIN + 1_000);
      const second = await storeException(storage, 'fam-A', 'b2', NOW + FIVE_MIN + 1_000);
      await alerter.evaluateFlush([second]);
      expect(sent).toHaveLength(1);
    });

    it('carries rich request context pulled from the batch', async () => {
      const { alerter, sent, storage } = makeAlerter([{ type: 'new-exception', window: '1h' }]);
      const ex = await storeException(storage, 'fam-A', 'b1', NOW);
      await alerter.evaluateFlush([ex]);
      const context = sent[0]?.exception;
      expect(context).toMatchObject({
        familyHash: 'fam-A',
        class: 'TypeError',
        message: 'boom',
        route: '/checkout',
        method: 'POST',
        statusCode: 500,
        durationMs: 1234,
        user: '42',
        occurrences: 1,
        entryId: 'ex-b1',
        batchId: 'b1',
      });
      expect(context?.stack).toContain('TypeError: boom');
    });

    it('ignores non-exception entries and those without a familyHash', async () => {
      const { alerter, sent } = makeAlerter([{ type: 'new-exception', window: '1h' }]);
      await alerter.evaluateFlush([
        entry('request', { durationMs: 10 }),
        entry('exception', { familyHash: null }),
      ]);
      expect(sent).toHaveLength(0);
    });

    it('fires for a brand-new client_exception with client context (url/userAgent)', async () => {
      const { alerter, sent, storage } = makeAlerter([{ type: 'new-exception', window: '1h' }]);
      const clientError = entry('client_exception', {
        id: 'ce-1',
        batchId: 'bc1',
        familyHash: 'fam-CLIENT',
        tags: ['failed', 'client', 'user:99'],
        content: {
          name: 'TypeError',
          message: 'x is undefined',
          stack: 'TypeError: x is undefined\n    at foo (app.js:1:1)',
          url: 'https://app.example.com/cart',
          userAgent: 'Mozilla/5.0',
          clientIp: '203.0.113.7',
        },
      });
      await storage.store([clientError]);
      await alerter.evaluateFlush([clientError]);

      expect(sent).toHaveLength(1);
      expect(sent[0]?.rule.type).toBe('new-exception');
      const context = sent[0]?.exception;
      expect(context).toMatchObject({
        familyHash: 'fam-CLIENT',
        class: 'TypeError',
        message: 'x is undefined',
        client: true,
        // For a client_exception, `route` carries the page URL and method is null.
        route: 'https://app.example.com/cart',
        method: null,
        userAgent: 'Mozilla/5.0',
        statusCode: null,
        user: '99',
        entryId: 'ce-1',
      });
    });

    it('evicts oldest families beyond the cap, re-firing an evicted family', async () => {
      const storage = new InMemoryStorageProvider();
      const sent: AlertPayload[] = [];
      const current = NOW;
      const alerter = new TelescopeAlerter({
        alerts: {
          channels: [
            customChannel(async (alert) => {
              sent.push(alert);
            }, 'capture'),
          ],
          dashboardUrl: null,
          intervalMs: 60_000,
          cooldownMs: 0,
          rules: [{ type: 'new-exception', window: '1h' }],
        },
        storage,
        instanceId: 'i',
        droppedCount: () => 0,
        now: () => current,
        maxFamilies: 2,
        logger: new Logger('test'),
      });

      const a = await storeException(storage, 'fam-A', 'ba', NOW);
      const b = await storeException(storage, 'fam-B', 'bb', NOW + 1);
      await alerter.evaluateFlush([a]);
      await alerter.evaluateFlush([b]);
      expect(sent).toHaveLength(2);

      // A third family evicts the oldest (fam-A).
      const c = await storeException(storage, 'fam-C', 'bc', NOW + 2);
      await alerter.evaluateFlush([c]);
      expect(sent).toHaveLength(3);

      // fam-A was evicted, so it is treated as NEW again and re-fires.
      const a2 = await storeException(storage, 'fam-A', 'ba2', NOW + 3);
      await alerter.evaluateFlush([a2]);
      expect(sent).toHaveLength(4);
    });
  });
});
