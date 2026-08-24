import type { RecordInput } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { type WireCustomMetric, labelKey } from '../wire/telemetry-wire.js';
import { EntryMetrics } from './entry-metrics.js';

function record(type: string, overrides: Partial<RecordInput> = {}): RecordInput {
  return { type, content: {}, ...overrides };
}

function counterKey(type: string, failed: boolean): string {
  return labelKey({ failed: failed ? 'true' : 'false', type });
}

function metric(metrics: WireCustomMetric[], name: string): WireCustomMetric | undefined {
  return metrics.find((m) => m.n === name);
}

function counterOf(metrics: WireCustomMetric[]): WireCustomMetric {
  const found = metric(metrics, 'telescope.entries');
  if (found === undefined) throw new Error('counter missing');
  return found;
}

function summaryOf(metrics: WireCustomMetric[]): WireCustomMetric {
  const found = metric(metrics, 'telescope.duration_ms');
  if (found === undefined) throw new Error('summary missing');
  return found;
}

function everyNumber(metrics: WireCustomMetric[]): number[] {
  const numbers: number[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'number') numbers.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item);
    }
  };
  walk(metrics);
  return numbers;
}

const clock = () => 1_700_000_000_000;

describe('EntryMetrics', () => {
  it('returns no metrics when nothing was observed', () => {
    expect(new EntryMetrics({ clock }).collect()).toEqual([]);
  });

  it('counts entries per type', () => {
    const metrics = new EntryMetrics({ clock });
    metrics.observe(record('request'));
    metrics.observe(record('request'));
    metrics.observe(record('query'));

    const counter = counterOf(metrics.collect());
    expect(counter.t).toBe('counter');
    expect(counter.l).toEqual(['failed', 'type']);
    expect(counter.lu).toBe(1_700_000_000_000);
    expect(counter.d).toBeTruthy();
    expect(counter.v).toEqual({
      [counterKey('request', false)]: 2,
      [counterKey('query', false)]: 1,
    });
  });

  it('splits a type into failed and not-failed series', () => {
    const metrics = new EntryMetrics({ clock });
    metrics.observe(record('request', { content: { statusCode: 200 } }));
    metrics.observe(record('request', { content: { statusCode: 503 } }));
    metrics.observe(record('request', { tags: ['failed'] }));

    const counter = counterOf(metrics.collect());
    expect(counter.v?.[counterKey('request', false)]).toBe(1);
    expect(counter.v?.[counterKey('request', true)]).toBe(2);
  });

  it('keeps v cumulative while iv is the increase since the previous collect', () => {
    const metrics = new EntryMetrics({ clock });
    const key = counterKey('job', false);

    metrics.observe(record('job'));
    metrics.observe(record('job'));
    const first = counterOf(metrics.collect());
    expect(first.v?.[key]).toBe(2);
    expect(first.iv?.[key]).toBe(2);

    metrics.observe(record('job'));
    const second = counterOf(metrics.collect());
    expect(second.v?.[key]).toBe(3);
    expect(second.iv?.[key]).toBe(1);

    const third = counterOf(metrics.collect());
    expect(third.v?.[key]).toBe(3);
    expect(third.iv?.[key]).toBe(0);
  });

  it('tracks ct, sm and mx exactly past the reservoir size', () => {
    const metrics = new EntryMetrics({ clock, sampleSize: 8 });
    for (let i = 1; i <= 500; i += 1) {
      metrics.observe(record('query', { durationMs: i }));
    }

    const summary = summaryOf(metrics.collect());
    const key = labelKey({ type: 'query' });
    expect(summary.t).toBe('summary');
    expect(summary.l).toEqual(['type']);
    expect(summary.ct?.[key]).toBe(500);
    expect(summary.sm?.[key]).toBe((500 * 501) / 2);
    expect(summary.mx?.[key]).toBe(500);
    expect(summary.v?.[key]).toBe((500 * 501) / 2);
  });

  it('orders quantiles and keeps them inside the observed range', () => {
    const metrics = new EntryMetrics({ clock, sampleSize: 32 });
    for (let i = 0; i < 2_000; i += 1) {
      metrics.observe(record('http_client', { durationMs: 10 + (i % 90) }));
    }

    const summary = summaryOf(metrics.collect());
    const key = labelKey({ type: 'http_client' });
    const q50 = summary.q50?.[key] as number;
    const q95 = summary.q95?.[key] as number;
    const q99 = summary.q99?.[key] as number;

    expect(q50).toBeLessThanOrEqual(q95);
    expect(q95).toBeLessThanOrEqual(q99);
    expect(q50).toBeGreaterThanOrEqual(10);
    expect(q99).toBeLessThanOrEqual(99);
  });

  it('reports a single observation as every quantile', () => {
    const metrics = new EntryMetrics({ clock });
    metrics.observe(record('mail', { durationMs: 42 }));

    const summary = summaryOf(metrics.collect());
    const key = labelKey({ type: 'mail' });
    expect(summary.q50?.[key]).toBe(42);
    expect(summary.q95?.[key]).toBe(42);
    expect(summary.q99?.[key]).toBe(42);
    expect(summary.mx?.[key]).toBe(42);
  });

  it('resets the summary each interval while the counter carries over', () => {
    const metrics = new EntryMetrics({ clock });
    const key = labelKey({ type: 'redis' });

    metrics.observe(record('redis', { durationMs: 100 }));
    const first = metrics.collect();
    expect(summaryOf(first).ct?.[key]).toBe(1);
    expect(summaryOf(first).mx?.[key]).toBe(100);

    metrics.observe(record('redis', { durationMs: 5 }));
    const second = metrics.collect();
    expect(summaryOf(second).ct?.[key]).toBe(1);
    expect(summaryOf(second).sm?.[key]).toBe(5);
    expect(summaryOf(second).mx?.[key]).toBe(5);
    expect(counterOf(second).v?.[counterKey('redis', false)]).toBe(2);

    const third = metrics.collect();
    expect(metric(third, 'telescope.duration_ms')).toBeUndefined();
    expect(counterOf(third).v?.[counterKey('redis', false)]).toBe(2);
  });

  it('refuses series past the cardinality ceiling and counts the drops', () => {
    const metrics = new EntryMetrics({ clock, maxSeriesPerMetric: 2 });
    metrics.observe(record('a'));
    metrics.observe(record('b'));
    metrics.observe(record('c'));
    metrics.observe(record('d'));

    expect(metrics.droppedSeries).toBe(2);
    const counter = counterOf(metrics.collect());
    expect(Object.keys(counter.v)).toHaveLength(2);
    expect(counter.v[counterKey('a', false)]).toBe(1);
    expect(counter.v[counterKey('c', false)]).toBeUndefined();
  });

  it('keeps counting an existing series once the ceiling is reached', () => {
    const metrics = new EntryMetrics({ clock, maxSeriesPerMetric: 1 });
    metrics.observe(record('a'));
    metrics.observe(record('b', { durationMs: 1 }));
    metrics.observe(record('a'));

    expect(counterOf(metrics.collect()).v[counterKey('a', false)]).toBe(2);
  });

  it('guards the summary cardinality separately from the counter', () => {
    const metrics = new EntryMetrics({ clock, maxSeriesPerMetric: 1 });
    metrics.observe(record('a', { durationMs: 1 }));
    metrics.observe(record('b', { durationMs: 2 }));

    // One refusal for the counter series, one for the summary series.
    expect(metrics.droppedSeries).toBe(2);
    const summary = summaryOf(metrics.collect());
    expect(Object.keys(summary.ct ?? {})).toEqual([labelKey({ type: 'a' })]);
  });

  it('leaves entries without a usable duration out of the summary', () => {
    const metrics = new EntryMetrics({ clock });
    metrics.observe(record('event', { durationMs: null }));
    metrics.observe(record('event'));
    metrics.observe(record('event', { durationMs: Number.NaN }));
    metrics.observe(record('event', { durationMs: Number.POSITIVE_INFINITY }));

    const collected = metrics.collect();
    expect(metric(collected, 'telescope.duration_ms')).toBeUndefined();
    expect(counterOf(collected).v[counterKey('event', false)]).toBe(4);
  });

  it('emits no non-finite number', () => {
    const metrics = new EntryMetrics({ clock, sampleSize: 4 });
    for (let i = 0; i < 50; i += 1) {
      metrics.observe(record('request', { durationMs: i, tags: i % 2 === 0 ? ['failed'] : [] }));
    }
    metrics.observe(record('log', { content: { level: 'error' }, durationMs: Number.NaN }));

    const numbers = everyNumber(metrics.collect());
    expect(numbers.length).toBeGreaterThan(0);
    for (const value of numbers) expect(Number.isFinite(value)).toBe(true);
  });
});
