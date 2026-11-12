// packages/core/src/sse/stream.controller.ts
import { Controller, Inject, Sse } from '@nestjs/common';
import { type Observable, merge, timer } from 'rxjs';
import { bufferTime, filter, map } from 'rxjs/operators';
import { activeTenantView } from '../storage/tenant-scoped-storage.js';
import { EntryEvents } from './entry-events.js';

type StreamMessage = { data: { types: string[] } | { heartbeat: true } };

@Controller()
export class StreamController {
  constructor(@Inject(EntryEvents) private readonly entryEvents: EntryEvents) {}

  @Sse('stream')
  stream(): Observable<StreamMessage> {
    // With tenancy on, a viewer of one organization only hears of that organization's entries.
    const view = activeTenantView();
    // Coalesce bursts: collect type-batches over a 300ms window, emit one tick
    // with the union of types. Skip empty windows.
    const ticks = this.entryEvents.events().pipe(
      map((events) =>
        (view === null ? events : events.filter((event) => view.accept(event))).map(
          (event) => event.type,
        ),
      ),
      bufferTime(300),
      map((batches) => [...new Set(batches.flat())]),
      filter((types) => types.length > 0),
      map((types) => ({ data: { types } }) as StreamMessage),
    );
    const heartbeat = timer(15_000, 15_000).pipe(
      map(() => ({ data: { heartbeat: true } }) as StreamMessage),
    );
    return merge(ticks, heartbeat);
  }
}
