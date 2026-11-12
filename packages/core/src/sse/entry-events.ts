import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Entry } from '../entry/entry.js';

/** What the bus carries of a just-persisted entry: its type and tags (tags name its organization). */
export type EntryEvent = Pick<Entry, 'type' | 'tags'>;

/**
 * Process-local bus of "these entries were just persisted". Fed from the
 * recorder's onFlushStored hook; consumed by the SSE stream to push invalidation
 * ticks. Stateless and best-effort — never throws into the flush path.
 */
@Injectable()
export class EntryEvents {
  private readonly subject = new Subject<EntryEvent[]>();

  /** Announces persisted entries (type and tags, never content). */
  emitEntries(entries: EntryEvent[]): void {
    if (entries.length === 0) return;
    try {
      this.subject.next(entries.map((entry) => ({ type: entry.type, tags: entry.tags })));
    } catch {
      // observability must never break the flush
    }
  }

  /** Announces persisted entries by type only (they carry no tags). */
  emitTypes(types: string[]): void {
    this.emitEntries([...new Set(types)].map((type) => ({ type, tags: [] })));
  }

  /** The entries of each flush. */
  events(): Observable<EntryEvent[]> {
    return this.subject.asObservable();
  }

  /** The distinct entry types of each flush. */
  stream(): Observable<string[]> {
    return this.events().pipe(map((events) => [...new Set(events.map((event) => event.type))]));
  }
}
