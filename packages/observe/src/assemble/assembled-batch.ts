import type { BatchOrigin, Entry } from '@dudousxd/nestjs-telescope';

/**
 * One Telescope batch, regrouped into the shape Observe's wire format wants: a
 * root operation plus the work it caused. Telescope records these as a flat
 * stream correlated by `batchId`, so reassembly is this package's job.
 */
export interface AssembledBatch {
  batchId: string;
  origin: BatchOrigin;
  /**
   * The entry that opened the batch — a `request` for an http origin, a `job`
   * for a queue or schedule one. Null when the batch was flushed without it,
   * which happens when capture sampling kept a child but dropped the root.
   */
  root: Entry | null;
  /** Everything else in the batch, ascending by `sequence`. */
  children: Entry[];
}
