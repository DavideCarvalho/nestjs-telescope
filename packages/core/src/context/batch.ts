// packages/core/src/context/batch.ts
import type { BatchOrigin } from '../entry/entry.js';

export interface Batch {
  id: string;
  origin: BatchOrigin;
  startedAt: Date;
  traceId?: string;
  spanId?: string;
}

/** Internal: mutable per-batch state held in the ALS store. */
export interface BatchState {
  batch: Batch;
  sequence: number;
}

export function createBatch(
  origin: BatchOrigin,
  idFactory: () => string,
  now: () => number = Date.now,
): Batch {
  return { id: idFactory(), origin, startedAt: new Date(now()) };
}
