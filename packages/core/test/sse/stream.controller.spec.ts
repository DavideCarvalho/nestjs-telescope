import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';
// packages/core/test/sse/stream.controller.spec.ts
import { describe, expect, it } from 'vitest';
import { EntryEvents } from '../../src/sse/entry-events.js';
import { StreamController } from '../../src/sse/stream.controller.js';

describe('StreamController', () => {
  it('coalesces a burst into one tick carrying the union of types', async () => {
    const bus = new EntryEvents();
    const ctrl = new StreamController(bus);
    const tick = firstValueFrom(
      ctrl.stream().pipe(
        filter((m) => 'types' in (m.data as object)),
        take(1),
      ),
    );
    bus.emitTypes(['durable']);
    bus.emitTypes(['durable', 'query']);
    const m = (await tick).data as { types: string[] };
    expect(m.types.sort()).toEqual(['durable', 'query']);
  });
});
