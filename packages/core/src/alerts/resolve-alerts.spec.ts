// packages/core/src/alerts/resolve-alerts.spec.ts
import { describe, expect, it } from 'vitest';
import type { AlertRule } from './alert-rule.js';
import { resolveAlerts } from './resolve-alerts.js';

const rule: AlertRule = { type: 'exception-rate', window: '5m', threshold: 10 };

describe('resolveAlerts', () => {
  it('returns null when alerts is unconfigured (feature off)', () => {
    expect(resolveAlerts(undefined)).toBeNull();
  });

  it('resolves defaults for every/cooldown when omitted', () => {
    const resolved = resolveAlerts({ webhookUrl: 'https://hook', rules: [rule] });
    expect(resolved).toEqual({
      webhookUrl: 'https://hook',
      intervalMs: 60_000,
      cooldownMs: 900_000,
      rules: [rule],
    });
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

  it('throws (fail-closed) when webhookUrl is empty', () => {
    expect(() => resolveAlerts({ webhookUrl: '   ', rules: [rule] })).toThrow(/webhookUrl/);
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

  it('throws on an unparseable every duration', () => {
    expect(() =>
      resolveAlerts({ webhookUrl: 'https://hook', every: 'often', rules: [rule] }),
    ).toThrow(/Invalid duration/);
  });
});
