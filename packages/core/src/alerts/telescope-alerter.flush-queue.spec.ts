import { Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { customChannel } from './alert-channel.js';
import type { AlertPayload, AlertRule } from './alert-rule.js';
import { TelescopeAlerter } from './telescope-alerter.js';

const NOW = 1_000_000_000_000;

function exception(familyHash: string): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    type: 'exception',
    familyHash,
    content: { class: 'Error', message: familyHash },
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(NOW),
  };
}

function alerterWith(
  rules: AlertRule[],
  send: (payload: AlertPayload) => Promise<void>,
  maxFamilies?: number,
): TelescopeAlerter {
  return new TelescopeAlerter({
    alerts: {
      channels: [customChannel(send, 'capture')],
      dashboardUrl: null,
      intervalMs: 60_000,
      cooldownMs: 900_000,
      rules,
      geoLookup: null,
    },
    storage: new InMemoryStorageProvider(),
    instanceId: 'i',
    droppedCount: () => 0,
    now: () => NOW,
    logger: new Logger('test'),
    ...(maxFamilies !== undefined ? { maxFamilies } : {}),
  });
}

describe('TelescopeAlerter flush evaluation queue', () => {
  it('evaluates flushes one at a time, in the order they were stored', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const alerter = alerterWith([{ type: 'new-exception', window: '1h' }], async (payload) => {
      const family = payload.exception?.familyHash ?? '';
      order.push(`start ${family}`);
      if (family === 'A') await firstHeld;
      order.push(`end ${family}`);
    });

    const first = alerter.evaluateFlush([exception('A')]);
    const second = alerter.evaluateFlush([exception('B')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['start A']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['start A', 'end A', 'start B', 'end B']);
  });

  it('bounds the per-family cooldown map by the family cap', async () => {
    const alerter = alerterWith([{ type: 'every-exception' }], async () => undefined, 3);
    for (let index = 0; index < 10; index += 1) {
      await alerter.evaluateFlush([exception(`F${index}`)]);
    }
    const cooldowns = (alerter as unknown as { lastFiredFamily: Map<string, number> })
      .lastFiredFamily;
    expect(cooldowns.size).toBe(3);
    expect([...cooldowns.keys()]).toEqual([
      'every-exception|F7',
      'every-exception|F8',
      'every-exception|F9',
    ]);
  });
});
