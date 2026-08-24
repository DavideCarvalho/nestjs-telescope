import type { Entry, JobContent } from '@dudousxd/nestjs-telescope';
import { EntryType } from '@dudousxd/nestjs-telescope';
import type { AssembledBatch } from '../assemble/assembled-batch.js';
import type { ResolvedObserveOptions } from '../observe-options.js';
import type { WireError, WireJob } from '../wire/telemetry-wire.js';
import { toChildSpans } from './child-spans.js';
import { entryStartMs } from './entry-start.js';
import { asRecord, finiteNumber, nonEmptyString, truncateTagValue } from './tag-values.js';
import { isFailureEntry, toWireError } from './wire-error.js';

const SCHEDULE_TAG_PREFIX = 'schedule:';

/**
 * Observe models a job as something that already ran: its status enum is
 * completed or failed only. A queued or processing run has no duration and no
 * outcome to report, so it is held back rather than forced into one of the two.
 */
function terminalStatus(status: unknown): 'completed' | 'failed' | null {
  return status === 'completed' || status === 'failed' ? status : null;
}

/**
 * The queue name to group scheduled runs by. Every scheduled task records the
 * constant `queue: 'schedule'`, so the only dimension that separates a cron from
 * an interval is the `schedule:<kind>` tag the schedule watcher attaches.
 */
function scheduleQueue(entry: Entry): string | undefined {
  for (const tag of entry.tags) {
    if (tag.startsWith(SCHEDULE_TAG_PREFIX) && tag.length > SCHEDULE_TAG_PREFIX.length) {
      return tag;
    }
  }
  return undefined;
}

function jobError(
  content: JobContent,
  children: readonly Entry[],
): [WireError | null, Entry | null] {
  for (const child of children) {
    if (!isFailureEntry(child)) continue;
    const error = toWireError(child);
    if (error !== null) return [error, child];
  }
  const reason = nonEmptyString(content.failureReason);
  // A `failureReason` is a bare string, so it opens no exception family — it is
  // still the only thing naming why the run failed.
  return reason === undefined ? [null, null] : [{ message: truncateTagValue(reason) }, null];
}

/**
 * One queue or schedule batch as an Observe job, or null when the batch is not
 * rooted at a job entry or has not reached a terminal status.
 */
export function encodeJob(batch: AssembledBatch, options: ResolvedObserveOptions): WireJob | null {
  const root = batch.root;
  if (root === null || root.type !== EntryType.Job) return null;
  const raw = asRecord(root.content);
  if (raw === null) return null;
  const content = raw as unknown as JobContent;

  const status = terminalStatus(content.status);
  if (status === null) return null;

  const [error, consumed] = jobError(content, batch.children);
  const name = nonEmptyString(content.name);
  const queue =
    batch.origin === 'schedule'
      ? (scheduleQueue(root) ?? nonEmptyString(content.queue))
      : nonEmptyString(content.queue);
  const duration = finiteNumber(root.durationMs);
  const waitMs = finiteNumber(content.waitMs);
  const attempts = finiteNumber(content.attempts);
  const maxAttempts = finiteNumber(content.maxAttempts);
  const startedAtMs = entryStartMs(root);
  const enqueuedAt =
    waitMs !== undefined && Number.isFinite(startedAtMs)
      ? new Date(startedAtMs - waitMs).toISOString()
      : undefined;
  const spans = options.include.spans ? toChildSpans(batch.children, startedAtMs, consumed) : [];

  return {
    i: nonEmptyString(content.id) ?? batch.batchId,
    s: status,
    c: new Date(startedAtMs).toISOString(),
    ti: nonEmptyString(root.traceId) ?? batch.batchId,
    ...(name !== undefined ? { n: name } : {}),
    ...(queue !== undefined ? { q: queue } : {}),
    ...(duration !== undefined ? { d: duration } : {}),
    ...(enqueuedAt !== undefined ? { ea: enqueuedAt } : {}),
    ...(waitMs !== undefined ? { wd: waitMs } : {}),
    ...(attempts !== undefined ? { am: attempts } : {}),
    ...(maxAttempts !== undefined ? { ma: maxAttempts } : {}),
    t: spans,
    ...(error !== null ? { e: error } : {}),
  };
}
