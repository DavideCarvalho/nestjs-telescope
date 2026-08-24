import { type Entry, isErrorEntry } from '@dudousxd/nestjs-telescope';
import type { AssembledBatch } from './assemble/assembled-batch.js';

/**
 * FNV-1a over the batch id, avalanched, mapped to [0, 1).
 *
 * The decision must be a function of the batch rather than a coin flip, because
 * a batch's entries are sampled once but arrive across several flushes: a random
 * draw would keep a request's snapshot and discard half of its spans.
 *
 * The finalizer is not decoration. FNV-1a alone barely mixes its low bits for
 * short, near-identical inputs, and batch ids are exactly that — a rate of 0.1
 * measured 0.15 over sequential ids before this was added.
 */
export function batchToUnitInterval(batchId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < batchId.length; index += 1) {
    hash ^= batchId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x100000000;
}

/**
 * Core's predicate answers "did something go wrong here" across every entry
 * type — a 5xx request, a failed job, an exception, a warn-or-worse log — which
 * is exactly the question sampling has to ask. It takes a `RecordInput`, so the
 * fields it reads are passed explicitly: an `Entry` is not assignable to one
 * (`traceId` is nullable on the former and optional on the latter).
 */
function isFailure(entry: Entry): boolean {
  return isErrorEntry({ type: entry.type, content: entry.content, tags: entry.tags });
}

/** A batch is a failure when anything in it is — the root's status, an exception child, an error-level log. */
export function batchHasFailure(batch: AssembledBatch): boolean {
  if (batch.root !== null && isFailure(batch.root)) return true;
  return batch.children.some(isFailure);
}

/**
 * Applied at encode time rather than on arrival, so the whole batch is visible:
 * a failure is never sampled away, and that can only be known once its children
 * have been gathered.
 */
export function shouldExportBatch(batch: AssembledBatch, sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (batchHasFailure(batch)) return true;
  if (sampleRate <= 0) return false;
  return batchToUnitInterval(batch.batchId) < sampleRate;
}
