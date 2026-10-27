import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertChannel } from '../alerts/alert-channel.js';
import type { AlertPayload } from '../alerts/alert-rule.js';
import { resolveConfig } from '../config/resolve-config.js';
import { Recorder } from '../recorder/recorder.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeService } from './telescope.service.js';

describe('TelescopeService flush path and /health', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('a stalled alert channel does not hold up the flush that stored the exception', async () => {
    const sent: AlertPayload[] = [];
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const channel: AlertChannel = {
      name: 'stalled',
      send: async (payload) => {
        sent.push(payload);
        await stalled;
      },
    };
    const service = new TelescopeService(
      resolveConfig({ recorder: { flushIntervalMs: 60_000 } }),
      new InMemoryStorageProvider(),
      { alerts: { channels: [channel], rules: [{ type: 'new-exception', window: '1h' }] } },
    );

    service.record({
      type: 'exception',
      familyHash: 'TypeError:boom',
      content: { class: 'TypeError', message: 'boom' },
    });
    const flushed = await Promise.race([
      service.flush().then(() => 'flushed'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 1_000)),
    ]);
    expect(flushed).toBe('flushed');

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    release();
    await service.onApplicationShutdown();
  });

  it('evaluates a family once per flush however many of its exceptions the flush stored', async () => {
    const storage = new InMemoryStorageProvider();
    const markFamilySeen = vi.spyOn(storage, 'markFamilySeen');
    const sent: AlertPayload[] = [];
    const service = new TelescopeService(
      resolveConfig({ recorder: { flushIntervalMs: 60_000 } }),
      storage,
      {
        alerts: {
          channels: [{ name: 'memory', send: async (payload) => void sent.push(payload) }],
          rules: [{ type: 'new-exception', window: '1h' }],
        },
      },
    );
    for (let index = 0; index < 50; index += 1) {
      service.record({
        type: 'exception',
        familyHash: `Error:${index % 2}`,
        content: { class: 'Error', message: String(index % 2) },
      });
    }
    await service.flush();
    await service.onApplicationShutdown();

    expect(markFamilySeen).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
  });

  it('reuses the capture-cost benchmark for a minute instead of re-running it per poll', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const benchmark = vi.spyOn(Recorder.prototype, 'benchmarkRecordCost');
    const service = new TelescopeService(resolveConfig({}), new InMemoryStorageProvider(), {});

    const first = service.getHealth().captureCostNanos;
    for (let poll = 0; poll < 10; poll += 1) {
      expect(service.getHealth().captureCostNanos).toBe(first);
    }
    expect(benchmark).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000_000 + 60_000);
    service.getHealth();
    expect(benchmark).toHaveBeenCalledTimes(2);
  });
});
