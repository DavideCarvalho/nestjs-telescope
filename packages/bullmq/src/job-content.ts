// packages/bullmq/src/job-content.ts
import type { JobContent } from '@dudousxd/nestjs-telescope';

/** The subset of a BullMQ `Job` this watcher reads. Kept structural so the
 *  content builder needs no bullmq runtime import and is trivially testable. */
export interface JobLike {
  id?: string | number;
  name?: string;
  queueName?: string;
  attemptsMade?: number;
  opts?: { attempts?: number };
  data?: unknown;
  /** Epoch ms when the job was enqueued (BullMQ `Job.timestamp`). */
  timestamp?: number;
  /** Epoch ms when the worker began processing (BullMQ `Job.processedOn`). */
  processedOn?: number;
}

/** The outcomes this watcher records (a subset of core JobContent['status']). */
export type JobStatus = 'completed' | 'failed';

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function waitMsOf(job: JobLike): number | null {
  return typeof job.processedOn === 'number' && typeof job.timestamp === 'number'
    ? job.processedOn - job.timestamp
    : null;
}

/** Normalize a BullMQ job + outcome into the canonical core `JobContent`.
 *  Redaction of `payload` is applied centrally by the core Recorder, not here.
 *  When `includeData` is false the payload is nulled (the field stays present
 *  so the persisted shape is stable). */
export function buildJobContent(
  job: JobLike,
  status: JobStatus,
  error: unknown,
  includeData: boolean,
): JobContent {
  return {
    id: job.id != null ? String(job.id) : null,
    name: job.name ?? '',
    queue: job.queueName ?? '',
    payload: includeData ? (job.data ?? null) : null,
    status,
    attempts: typeof job.attemptsMade === 'number' ? job.attemptsMade : 0,
    maxAttempts: typeof job.opts?.attempts === 'number' ? job.opts.attempts : null,
    waitMs: waitMsOf(job),
    failureReason: status === 'failed' ? failureMessage(error) : null,
  };
}
