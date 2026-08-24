import type { Entry } from '@dudousxd/nestjs-telescope';
import { EntryType } from '@dudousxd/nestjs-telescope';
import type { WireSpan } from '../wire/telemetry-wire.js';
import { entryToSpan } from './entry-to-span.js';

/**
 * Entry types that Observe models as records of their own. One can still turn
 * up among a batch's children — a host that registers request capture twice
 * produces two `request` entries per batch, and the assembler demotes the
 * second — but a request is never a span inside itself, and a job belongs in
 * `jobs[]`. Encoding either would bill for a duplicate that says nothing.
 */
const RECORD_TYPES: ReadonlySet<string> = new Set([EntryType.Request, EntryType.Job]);

/**
 * The children of a snapshot or job that belong on its span tree.
 *
 * Held back, because Observe bills per ingested record and would otherwise
 * charge twice for the same entry: `log` entries, which ship in `logs[]`;
 * whichever failure entry was already lifted onto the record's own `e`; and
 * anything that is a record type in its own right. Always an array, empty
 * included: the collector rejects a snapshot whose `t` is absent.
 */
export function toChildSpans(
  children: readonly Entry[],
  rootStartMs: number,
  consumed: Entry | null,
): WireSpan[] {
  const spans: WireSpan[] = [];
  for (const child of children) {
    if (child.type === EntryType.Log) continue;
    if (RECORD_TYPES.has(child.type)) continue;
    if (consumed !== null && child.id === consumed.id) continue;
    spans.push(entryToSpan(child, rootStartMs));
  }
  return spans;
}
