// packages/core/test/alerts/integrations/routing.spec.ts
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { type AlertChannel, customChannel } from '../../../src/alerts/alert-channel.js';
import type { AlertPayload, AlertRule, ResolvedAlerts } from '../../../src/alerts/alert-rule.js';
import { pagerDutyChannel } from '../../../src/alerts/integrations/on-call.js';
import { resolveAlerts } from '../../../src/alerts/resolve-alerts.js';
import { TelescopeAlerter } from '../../../src/alerts/telescope-alerter.js';
import { InMemoryStorageProvider } from '../../../src/storage/in-memory-storage-provider.js';
import { fakeSleep, mockFetch } from './helpers.js';

function capture(name: string, extra: Partial<AlertChannel> = {}) {
  const sent: AlertPayload[] = [];
  const channel: AlertChannel = {
    ...customChannel(async (alert) => {
      sent.push(alert);
    }, name),
    ...extra,
  };
  return { channel, sent };
}

function makeAlerter(
  channels: AlertChannel[],
  rules: AlertRule[],
  partial: Partial<ResolvedAlerts> = {},
  logger: Logger = new Logger('test'),
) {
  const dropped = { value: 0 };
  const alerter = new TelescopeAlerter({
    alerts: {
      channels,
      dashboardUrl: null,
      intervalMs: 60_000,
      cooldownMs: 0,
      rules,
      geoLookup: null,
      ...partial,
    },
    storage: new InMemoryStorageProvider(),
    instanceId: 'web-1',
    droppedCount: () => dropped.value,
    logger,
  });
  return { alerter, dropped };
}

describe('routing', () => {
  it('sends a rule only to the channels it names', async () => {
    const ops = capture('ops');
    const dev = capture('dev');
    const { alerter, dropped } = makeAlerter(
      [ops.channel, dev.channel],
      [{ type: 'dropped-entries', threshold: 1, channels: ['ops'] }],
    );
    dropped.value = 5;
    await alerter.evaluate();
    expect(ops.sent).toHaveLength(1);
    expect(dev.sent).toHaveLength(0);
  });

  it("filters on a channel's minSeverity (rule override wins over the kind default)", async () => {
    const run = async (rule: AlertRule) => {
      const pager = capture('pager', { minSeverity: 'critical' });
      const chat = capture('chat');
      const { alerter, dropped } = makeAlerter([pager.channel, chat.channel], [rule]);
      dropped.value = 5;
      await alerter.evaluate();
      return { pager: pager.sent.length, chat: chat.sent.length };
    };
    // dropped-entries is `warning` by default: below the pager's floor.
    expect(await run({ type: 'dropped-entries', threshold: 1 })).toEqual({ pager: 0, chat: 1 });
    expect(await run({ type: 'dropped-entries', threshold: 1, severity: 'critical' })).toEqual({
      pager: 1,
      chat: 1,
    });
  });

  it('sends resolved only to channels that accept it, once', async () => {
    const legacy = capture('legacy');
    const oncall = capture('oncall', { acceptsResolved: true });
    const { alerter, dropped } = makeAlerter(
      [legacy.channel, oncall.channel],
      [{ type: 'dropped-entries', threshold: 1 }],
    );
    dropped.value = 3;
    await alerter.evaluate(); // fires
    await alerter.evaluate(); // delta 0: resolves
    await alerter.evaluate(); // still clear: nothing
    expect(legacy.sent.map((p) => p.status ?? 'firing')).toEqual(['firing']);
    expect(oncall.sent.map((p) => p.status ?? 'firing')).toEqual(['firing', 'resolved']);
    // A firing payload stays v1-shaped (no status/app keys added).
    expect(legacy.sent[0]).not.toHaveProperty('status');
    expect(legacy.sent[0]).not.toHaveProperty('app');
  });

  it('stamps alerts.app on payloads when set', async () => {
    const { channel, sent } = capture('c');
    const { alerter, dropped } = makeAlerter(
      [channel],
      [{ type: 'dropped-entries', threshold: 1 }],
      { app: 'api' },
    );
    dropped.value = 1;
    await alerter.evaluate();
    expect(sent[0]?.app).toBe('api');
  });

  it('PagerDuty triggers then resolves the same dedup_key through the alerter', async () => {
    const { fetch, calls } = mockFetch();
    const { alerter, dropped } = makeAlerter(
      [pagerDutyChannel({ routingKey: 'k', fetch })],
      [{ type: 'dropped-entries', threshold: 1 }],
      { app: 'api' },
    );
    dropped.value = 2;
    await alerter.evaluate();
    await alerter.evaluate();
    const bodies = calls.map((c) => c.json as { event_action: string; dedup_key: string });
    expect(bodies.map((b) => b.event_action)).toEqual(['trigger', 'resolve']);
    expect(bodies[0]?.dedup_key).toBe('telescope:api:dropped-entries:1');
    expect(bodies[1]?.dedup_key).toBe(bodies[0]?.dedup_key);
  });

  it('isolates a failing integration and logs it by name, never its secret', async () => {
    const { fetch } = mockFetch([{ status: 500 }]);
    const { sleep } = fakeSleep();
    const logger = new Logger('test');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const ok = capture('ok');
    const { alerter, dropped } = makeAlerter(
      [pagerDutyChannel({ routingKey: 'SUPER-SECRET-KEY', fetch, sleep }), ok.channel],
      [{ type: 'dropped-entries', threshold: 1 }],
      {},
      logger,
    );
    dropped.value = 1;
    await alerter.evaluate();
    expect(ok.sent).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("Telescope alert channel 'pagerduty' failed: HTTP 500");
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SUPER-SECRET-KEY');
  });
});

describe('resolveAlerts with integrations', () => {
  const channel = customChannel(async () => {}, 'ops');

  it('allows an uptime-only setup with no rules or channels', () => {
    const resolved = resolveAlerts({
      heartbeats: [{ provider: 'healthchecks', url: 'https://hc-ping.com/uuid' }],
    });
    expect(resolved?.rules).toEqual([]);
    expect(resolved?.channels).toEqual([]);
    expect(resolved?.heartbeats).toHaveLength(1);
  });

  it('still requires rules when there is nothing else to do', () => {
    expect(() => resolveAlerts({ channels: [channel] })).toThrow('`rules` is required');
  });

  it('fails closed on a rule routed to an unknown channel', () => {
    expect(() =>
      resolveAlerts({
        channels: [channel],
        rules: [{ type: 'new-exception', window: '1h', channels: ['opz'] }],
      }),
    ).toThrow("routes to channel 'opz'");
  });

  it('fails closed on a malformed heartbeat URL without echoing it', () => {
    let message = '';
    try {
      resolveAlerts({ heartbeats: [{ provider: 'url', url: 'not a url s3cr3t' }] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Telescope heartbeat 'url': invalid url");
  });

  it('fails closed on a status page without its key', () => {
    expect(() =>
      resolveAlerts({
        statusPages: [{ provider: 'statuspage', apiKey: '', pageId: 'p', components: { a: 'b' } }],
      }),
    ).toThrow("Telescope status page 'statuspage': missing apiKey");
  });

  it('keeps app and the check-state source', () => {
    const checkStates = () => [];
    const resolved = resolveAlerts({
      app: 'api',
      channels: [channel],
      rules: [{ type: 'new-exception', window: '1h' }],
      checkStates,
    });
    expect(resolved?.app).toBe('api');
    expect(resolved?.checkStates).toBe(checkStates);
  });
});
