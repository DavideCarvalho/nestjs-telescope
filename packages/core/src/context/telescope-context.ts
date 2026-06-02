// packages/core/src/context/telescope-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Batch } from './batch.js';

/** Internal: mutable per-batch state held in the ALS store. */
interface BatchState {
  batch: Batch;
  sequence: number;
}

export class TelescopeContext {
  private readonly als = new AsyncLocalStorage<BatchState>();

  run<T>(batch: Batch, fn: () => Promise<T>): Promise<T> {
    return this.als.run({ batch, sequence: 0 }, fn);
  }

  current(): Batch | undefined {
    return this.als.getStore()?.batch;
  }

  /** Next capture-order index within the active batch; 0 outside any batch. */
  nextSequence(): number {
    const state = this.als.getStore();
    if (!state) {
      return 0;
    }
    const next = state.sequence;
    state.sequence += 1;
    return next;
  }
}
