// packages/core/src/sse/stream.controller.ts
import { Controller, Inject, Sse } from '@nestjs/common';
import { type Observable, merge, timer } from 'rxjs';
import { bufferTime, filter, map } from 'rxjs/operators';
import { EntryEvents } from './entry-events.js';

type StreamMessage = { data: { types: string[] } | { heartbeat: true } };

@Controller()
export class StreamController {
  constructor(@Inject(EntryEvents) private readonly entryEvents: EntryEvents) {}

  @Sse('stream')
  stream(): Observable<StreamMessage> {
    // Coalesce bursts: collect type-batches over a 300ms window, emit one tick
    // with the union of types. Skip empty windows.
    const ticks = this.entryEvents.stream().pipe(
      bufferTime(300),
      filter((batches) => batches.length > 0),
      map((batches) => ({ data: { types: [...new Set(batches.flat())] } }) as StreamMessage),
    );
    const heartbeat = timer(15_000, 15_000).pipe(
      map(() => ({ data: { heartbeat: true } }) as StreamMessage),
    );
    return merge(ticks, heartbeat);
  }
}
