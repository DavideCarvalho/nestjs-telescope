// packages/core/src/alerts/resolve-alerts.spec.ts
import { describe, expect, it } from 'vitest';
import { customChannel } from './alert-channel.js';
import type { AlertRule } from './alert-rule.js';
import { resolveAlerts } from './resolve-alerts.js';

const rule: AlertRule = { type: 'exception-rate', window: '5m', threshold: 10 };

describe('resolveAlerts', () => {
  it('returns null when alerts is unconfigured (feature off)', () => {
    expect(resolveAlerts(undefined)).toBeNull();
  });

  it('folds a legacy webhookUrl into a webhook channel (backward compat)', () => {
    const resolved = resolveAlerts({ webhookUrl: 'https://hook', rules: [rule] });
    expect(resolved?.channels).toHaveLength(1);
    expect(resolved?.channels[0]?.name).toBe('webhook');
    expect(resolved?.intervalMs).toBe(60_000);
    expect(resolved?.cooldownMs).toBe(900_000);
    expect(resolved?.dashboardUrl).toBeNull();
  });

  it('keeps explicit channels and appends the legacy webhookUrl after them', () => {
    const custom = customChannel(async () => {}, 'mine');
    const resolved = resolveAlerts({
      channels: [custom],
      webhookUrl: 'https://hook',
      rules: [rule],
    });
    expect(resolved?.channels.map((c) => c.name)).toEqual(['mine', 'webhook']);
  });

  it('resolves dashboardUrl when provided', () => {
    const resolved = resolveAlerts({
      channels: [customChannel(async () => {})],
      dashboardUrl: 'https://telescope.example/telescope/',
      rules: [rule],
    });
    expect(resolved?.dashboardUrl).toBe('https://telescope.example/telescope/');
  });

  it('resolves custom every/cooldown durations to ms', () => {
    const resolved = resolveAlerts({
      webhookUrl: 'https://hook',
      every: '30s',
      cooldown: '1h',
      rules: [rule],
    });
    expect(resolved?.intervalMs).toBe(30_000);
    expect(resolved?.cooldownMs).toBe(3_600_000);
  });

  it('throws (fail-closed) when no destination is configured', () => {
    expect(() => resolveAlerts({ rules: [rule] })).toThrow(/destination/);
  });

  it('throws (fail-closed) when webhookUrl is blank and no channels are set', () => {
    expect(() => resolveAlerts({ webhookUrl: '   ', rules: [rule] })).toThrow(/destination/);
  });

  it('throws (fail-closed) when rules is empty', () => {
    expect(() => resolveAlerts({ webhookUrl: 'https://hook', rules: [] })).toThrow(/rules/);
  });

  it('throws on an unparseable rule window duration', () => {
    expect(() =>
      resolveAlerts({
        webhookUrl: 'https://hook',
        rules: [{ type: 'slow-request-rate', window: 'soon', thresholdMs: 500, count: 5 }],
      }),
    ).toThrow(/Invalid duration/);
  });

  it('validates the new-exception rule window at boot', () => {
    expect(() =>
      resolveAlerts({
        webhookUrl: 'https://hook',
        rules: [{ type: 'new-exception', window: 'eventually' }],
      }),
    ).toThrow(/Invalid duration/);
  });

  it('throws on an unparseable every duration', () => {
    expect(() =>
      resolveAlerts({ webhookUrl: 'https://hook', every: 'often', rules: [rule] }),
    ).toThrow(/Invalid duration/);
  });
});
