import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { Observable } from 'rxjs';

/**
 * Process-local bus of "entries of these types were just persisted". Fed from the
 * recorder's onFlushStored hook; consumed by the SSE stream to push invalidation
 * ticks. Stateless and best-effort — never throws into the flush path.
 */
@Injectable()
export class EntryEvents {
  private readonly subject = new Subject<string[]>();

  emitTypes(types: string[]): void {
    const unique = [...new Set(types)];
    if (unique.length === 0) return;
    try {
      this.subject.next(unique);
    } catch {
      // observability must never break the flush
    }
  }

  stream(): Observable<string[]> {
    return this.subject.asObservable();
  }
}
