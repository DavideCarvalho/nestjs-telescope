// packages/core/src/sse/stream.controller.spec.ts
import { describe, expect, it } from 'vitest';
import { openTenantView, tenantViewOf } from '../storage/tenant-scoped-storage.js';
import { EntryEvents } from './entry-events.js';
import { StreamController } from './stream.controller.js';

/** The `types` of the first tick `subscribe` hears after `emit` runs. */
async function firstTick(
  subscribe: (events: EntryEvents, onTypes: (types: string[]) => void) => () => void,
  emit: (events: EntryEvents) => void,
): Promise<string[] | null> {
  const events = new EntryEvents();
  const heard: string[][] = [];
  const stop = subscribe(events, (types) => heard.push(types));
  emit(events);
  await new Promise((resolve) => setTimeout(resolve, 400));
  stop();
  return heard[0] ?? null;
}

function listen(view: ReturnType<typeof tenantViewOf>) {
  return (events: EntryEvents, onTypes: (types: string[]) => void) => {
    const controller = new StreamController(events);
    const run = <T>(fn: () => T): T => (view === null ? fn() : openTenantView(view).run(fn));
    const subscription = run(() =>
      controller.stream().subscribe((message) => {
        if ('types' in message.data) onTypes(message.data.types);
      }),
    );
    return () => subscription.unsubscribe();
  };
}

const flush = (events: EntryEvents) =>
  events.emitEntries([
    { type: 'request', tags: ['tenant:A'] },
    { type: 'exception', tags: ['tenant:B'] },
  ]);

describe('StreamController', () => {
  it('with no view, ticks every type', async () => {
    expect((await firstTick(listen(null), flush))?.sort()).toEqual(['exception', 'request']);
  });

  it("one organization's view only hears of that organization's entries", async () => {
    const viewA = tenantViewOf({ kind: 'tenant', id: 'A' }, 'tenant', 'tenantless');
    expect(await firstTick(listen(viewA), flush)).toEqual(['request']);
    const viewC = tenantViewOf({ kind: 'tenant', id: 'C' }, 'tenant', 'tenantless');
    expect(await firstTick(listen(viewC), flush)).toBeNull();
  });
});
