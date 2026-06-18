import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
// packages/core/test/sse/entry-events.spec.ts
import { describe, expect, it } from 'vitest';
import { EntryEvents } from '../../src/sse/entry-events.js';

describe('EntryEvents', () => {
  it('multicasts emitted type batches to subscribers', async () => {
    const bus = new EntryEvents();
    const got = firstValueFrom(bus.stream().pipe(take(2), toArray()));
    bus.emitTypes(['durable', 'request']);
    bus.emitTypes(['durable']);
    expect(await got).toEqual([['durable', 'request'], ['durable']]);
  });

  it('dedupes types within a batch', async () => {
    const bus = new EntryEvents();
    const got = firstValueFrom(bus.stream().pipe(take(1)));
    bus.emitTypes(['durable', 'durable', 'query']);
    expect((await got).sort()).toEqual(['durable', 'query']);
  });
});
