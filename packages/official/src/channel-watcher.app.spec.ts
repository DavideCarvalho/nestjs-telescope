// packages/official/src/channel-watcher.app.spec.ts
import diagnostics_channel from 'node:diagnostics_channel';
import type { RecordInput, WatcherContext } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { ChannelWatcher, appOfEvent } from './channel-watcher.js';

describe('the app an event is about', () => {
  it('reads the envelope app first, then the payload app, ignoring invalid names', () => {
    expect(
      appOfEvent({ lib: 'durable', event: 'x', payload: { app: 'billing' }, app: 'shop' }),
    ).toBe('shop');
    expect(appOfEvent({ lib: 'durable', event: 'x', payload: { app: 'billing' } })).toBe('billing');
    expect(appOfEvent({ app: 'billing' })).toBe('billing');
    expect(appOfEvent({ app: '', payload: { app: 'bad name' } })).toBeNull();
    expect(appOfEvent({ app: 42 })).toBeNull();
    expect(appOfEvent(null)).toBeNull();
    expect(appOfEvent('x')).toBeNull();
  });

  it('tags the entry app:<name>, unless the mapper already set an app tag', () => {
    const recorded: RecordInput[] = [];
    const ctx = {
      record: (input: RecordInput) => recorded.push(input),
    } as unknown as WatcherContext;
    const channel = 'test:relay-app:event';
    const watcher = new ChannelWatcher('event', [channel], (_name, message) => ({
      type: 'event',
      content: message,
      tags: (message as { tags?: string[] }).tags ?? ['event'],
    }));
    watcher.register(ctx);
    const bus = diagnostics_channel.channel(channel);
    try {
      bus.publish({ payload: {}, app: 'shop' });
      bus.publish({ payload: { app: 'billing' } });
      bus.publish({ payload: {} });
      bus.publish({ payload: {}, app: 'shop', tags: ['app:own'] });
    } finally {
      watcher.unregister();
    }
    expect(recorded.map((input) => input.tags)).toEqual([
      ['event', 'app:shop'],
      ['event', 'app:billing'],
      ['event'],
      ['app:own'],
    ]);
  });
});
