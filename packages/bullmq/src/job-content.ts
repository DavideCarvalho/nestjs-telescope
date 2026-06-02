// packages/bullmq/src/job-content.ts

/** The subset of a BullMQ `Job` this watcher reads. Kept structural so the
 *  content builder needs no bullmq runtime import and is trivially testable. */
export interface JobLike {
  id?: string | number;
  name?: string;
  queueName?: string;
  attemptsMade?: number;
  opts?: { attempts?: number };
  data?: unknown;
}

export type JobStatus = 'completed' | 'failed';

/** Shape persisted as an `Entry.content` for a `job` entry. `data` is omitted
 *  (not null) when capture is disabled, so the column simply isn't present. */
export interface JobContent {
  id: string | null;
  name: string | null;
  queue: string | null;
  status: JobStatus;
  attemptsMade: number | null;
  maxAttempts: number | null;
  failedReason: string | null;
  data?: unknown;
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Normalize a BullMQ job + outcome into a redaction-friendly content object.
 *  Redaction of `data` is applied centrally by the core Recorder, not here. */
export function buildJobContent(
  job: JobLike,
  status: JobStatus,
  error: unknown,
  includeData: boolean,
): JobContent {
  const content: JobContent = {
    id: job.id != null ? String(job.id) : null,
    name: job.name ?? null,
    queue: job.queueName ?? null,
    status,
    attemptsMade: typeof job.attemptsMade === 'number' ? job.attemptsMade : null,
    maxAttempts: typeof job.opts?.attempts === 'number' ? job.opts.attempts : null,
    failedReason: status === 'failed' ? failureMessage(error) : null,
  };
  if (includeData) content.data = job.data;
  return content;
}
