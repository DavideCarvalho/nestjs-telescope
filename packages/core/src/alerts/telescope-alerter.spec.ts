// packages/core/src/alerts/telescope-alerter.spec.ts
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
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

function resolved(rules: AlertRule[], partial: Partial<ResolvedAlerts> = {}): ResolvedAlerts {
  return {
    webhookUrl: 'https://hook.example/x',
    intervalMs: 60_000,
    cooldownMs: 900_000,
    rules,
    ...partial,
  };
}

interface Harness {
  alerter: TelescopeAlerter;
  fetchMock: ReturnType<typeof vi.fn>;
  storage: InMemoryStorageProvider;
  now: () => number;
  setNow: (ms: number) => void;
  dropped: { value: number };
}

function makeAlerter(rules: AlertRule[], partial: Partial<ResolvedAlerts> = {}): Harness {
  const storage = new InMemoryStorageProvider();
  const fetchMock = vi.fn(() => Promise.resolve(undefined));
  const dropped = { value: 0 };
  let current = NOW;
  const now = () => current;
  const alerter = new TelescopeAlerter({
    alerts: resolved(rules, partial),
    storage,
    instanceId: 'instance-7',
    droppedCount: () => dropped.value,
    now,
    fetch: fetchMock,
    logger: new Logger('test'),
  });
  function setNow(ms: number): void {
    current = ms;
  }
  return { alerter, fetchMock, storage, now, setNow, dropped };
}

function payloadOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): AlertPayload {
  const body = fetchMock.mock.calls[call]?.[1]?.body as string;
  return JSON.parse(body) as AlertPayload;
}

describe('TelescopeAlerter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exception-rate fires at threshold and POSTs the payload shape', async () => {
    const rule: AlertRule = { type: 'exception-rate', window: '5m', threshold: 3 };
    const { alerter, fetchMock, storage } = makeAlerter([rule]);
    await storage.store([entry('exception'), entry('exception'), entry('exception')]);
    await alerter.evaluate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://hook.example/x');
    expect(init?.method).toBe('POST');
    const payload = payloadOf(fetchMock);
    expect(payload).toMatchObject({
      rule,
      value: 3,
      threshold: 3,
      instanceId: 'instance-7',
      firedAt: new Date(NOW).toISOString(),
    });
  });

  it('exception-rate does NOT fire under threshold', async () => {
    const { alerter, fetchMock, storage } = makeAlerter([
      { type: 'exception-rate', window: '5m', threshold: 3 },
    ]);
    await storage.store([entry('exception'), entry('exception')]);
    await alerter.evaluate();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('slow-request-rate counts only requests slower than thresholdMs', async () => {
    const { alerter, fetchMock, storage } = makeAlerter([
      { type: 'slow-request-rate', window: '5m', thresholdMs: 500, count: 2 },
    ]);
    await storage.store([
      entry('request', { durationMs: 600 }),
      entry('request', { durationMs: 800 }),
      entry('request', { durationMs: 100 }),
    ]);
    await alerter.evaluate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payloadOf(fetchMock).value).toBe(2);
  });

  it('cooldown suppresses a re-fire then re-allows after it elapses', async () => {
    const rule: AlertRule = { type: 'exception-rate', window: '5m', threshold: 1 };
    const { alerter, fetchMock, storage, setNow } = makeAlerter([rule], { cooldownMs: 10_000 });
    await storage.store([entry('exception')]);
    await alerter.evaluate();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Within cooldown: suppressed.
    setNow(NOW + 5_000);
    await alerter.evaluate();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After cooldown: re-allowed.
    setNow(NOW + 11_000);
    await alerter.evaluate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('dropped-entries fires on the delta since the previous evaluation', async () => {
    const { alerter, fetchMock, dropped } = makeAlerter(
      [{ type: 'dropped-entries', threshold: 5 }],
      { cooldownMs: 0 },
    );
    // Baseline captured in the constructor is 0; bump by 6 → delta 6 >= 5.
    dropped.value = 6;
    await alerter.evaluate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payloadOf(fetchMock).value).toBe(6);

    // No new drops → delta 0 → no fire.
    await alerter.evaluate();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Another burst of 5 → delta 5 → fires again.
    dropped.value = 11;
    await alerter.evaluate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('swallows a webhook failure and warns once per rule kind', async () => {
    const rule: AlertRule = { type: 'exception-rate', window: '5m', threshold: 1 };
    const { alerter, fetchMock, storage } = makeAlerter([rule], { cooldownMs: 0 });
    fetchMock.mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await storage.store([entry('exception')]);
    // Two evaluations, both fail; must NOT throw and must warn once.
    await expect(alerter.evaluate()).resolves.toBeUndefined();
    await alerter.evaluate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const exceptionWarns = warn.mock.calls.filter((c) => String(c[0]).includes('exception-rate'));
    expect(exceptionWarns).toHaveLength(1);
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
});
