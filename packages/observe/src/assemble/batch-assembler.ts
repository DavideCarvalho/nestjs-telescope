import type { BatchOrigin, Entry } from '@dudousxd/nestjs-telescope';
import type { ResolvedObserveOptions } from '../observe-options.js';
import type { AssembledBatch } from './assembled-batch.js';

export type BatchAssemblerOptions = Pick<
  ResolvedObserveOptions,
  'batchGraceMs' | 'maxOpenBatches' | 'clock' | 'logger'
>;

interface OpenBatch {
  batchId: string;
  origin: BatchOrigin;
  root: Entry | null;
  children: Entry[];
  lastTouchedAt: number;
}

const ROOT_ORIGINS: Record<string, readonly BatchOrigin[]> = {
  request: ['http'],
  job: ['queue', 'schedule'],
};

function isRoot(entry: Entry): boolean {
  return ROOT_ORIGINS[entry.type]?.includes(entry.origin) ?? false;
}

/** Telescope's within-batch capture order; `createdAt` only breaks ties. */
function byCaptureOrder(a: Entry, b: Entry): number {
  return a.sequence - b.sequence || a.createdAt.getTime() - b.createdAt.getTime();
}

function assemble(batch: OpenBatch): AssembledBatch {
  return {
    batchId: batch.batchId,
    origin: batch.origin,
    root: batch.root,
    children: [...batch.children].sort(byCaptureOrder),
  };
}

/**
 * Regroups the flat entry stream `TelescopeExtension.observeFlush` delivers back
 * into whole batches. Telescope flushes on its own timer, so one request's
 * entries routinely straddle several flushes and its `request` entry — recorded
 * on response finish — usually arrives after the children it caused.
 *
 * Timer-free and synchronous on purpose: the owning exporter already has a flush
 * loop, and a class that only moves time through `options.clock` is testable
 * without waiting.
 */
export class BatchAssembler {
  private readonly open = new Map<string, OpenBatch>();
  /** Batches shed by the ceiling, held until the next drain so they still ship. */
  private readonly evicted: AssembledBatch[] = [];
  private evictedSinceLastDrain = 0;
  private duplicateRoots = 0;

  constructor(private readonly options: BatchAssemblerOptions) {}

  /** Open batch count, for the exporter's own diagnostics. Excludes batches already shed. */
  get openCount(): number {
    return this.open.size;
  }

  /** How many extra root candidates have been demoted to children, for diagnostics. */
  get duplicateRootCount(): number {
    return this.duplicateRoots;
  }

  add(entries: Entry[]): void {
    for (const entry of entries) {
      this.accept(entry);
    }
    this.enforceCeiling();
  }

  /**
   * Batches whose grace window has elapsed, removed from the assembler. The
   * window runs from a batch's LAST entry, not its first, so a slow request
   * still accumulating spans is never cut in half. Seeing the root is not a
   * shortcut out of it — Telescope's flush ordering does not guarantee the root
   * arrives after every child it caused.
   */
  drain(): AssembledBatch[] {
    const now = this.options.clock();
    const ready = this.takeEvicted();

    for (const batch of this.open.values()) {
      if (now - batch.lastTouchedAt >= this.options.batchGraceMs) {
        this.open.delete(batch.batchId);
        ready.push(assemble(batch));
      }
    }

    return ready;
  }

  /** Every open batch, removed — for shutdown, so nothing in flight is lost. */
  drainAll(): AssembledBatch[] {
    const all = this.takeEvicted();
    for (const batch of this.open.values()) {
      all.push(assemble(batch));
    }
    this.open.clear();
    return all;
  }

  private accept(entry: Entry): void {
    let batch = this.open.get(entry.batchId);
    if (!batch) {
      // An entry for an already-drained batch opens a fresh, rootless one rather
      // than reattaching: the drained batch is gone, and shipping orphan spans is
      // the encoder's call, not a reason to hold every batchId forever.
      batch = {
        batchId: entry.batchId,
        origin: entry.origin,
        root: null,
        children: [],
        lastTouchedAt: 0,
      };
    }

    if (!isRoot(entry)) {
      batch.children.push(entry);
    } else if (batch.root === null) {
      batch.root = entry;
    } else {
      // Two roots under one batchId should not happen; keeping the second as a
      // child loses nothing and beats throwing inside a flush.
      this.duplicateRoots += 1;
      this.options.logger.debug?.(
        `batch ${entry.batchId} produced a second root candidate (${entry.type}); kept the first`,
      );
      batch.children.push(entry);
    }

    batch.lastTouchedAt = this.options.clock();
    // Re-inserting keeps the map ordered by last touch, so the ceiling can shed
    // from the front without scanning.
    this.open.delete(batch.batchId);
    this.open.set(batch.batchId, batch);
  }

  /** Sheds the least recently touched batches; they are still worth exporting, so they queue for the next drain. */
  private enforceCeiling(): void {
    while (this.open.size > this.options.maxOpenBatches) {
      const oldest = this.open.values().next().value;
      if (!oldest) {
        return;
      }
      this.open.delete(oldest.batchId);
      this.evicted.push(assemble(oldest));
      this.evictedSinceLastDrain += 1;
    }
  }

  private takeEvicted(): AssembledBatch[] {
    const shed = this.evicted.splice(0, this.evicted.length);
    if (this.evictedSinceLastDrain > 0) {
      this.options.logger.warn(
        `${this.evictedSinceLastDrain} batch(es) force-emitted after exceeding maxOpenBatches ` +
          `(${this.options.maxOpenBatches}); entries are arriving faster than they are drained`,
      );
      this.evictedSinceLastDrain = 0;
    }
    return shed;
  }
}
