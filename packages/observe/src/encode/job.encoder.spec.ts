import type { BatchOrigin, Entry } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import type { AssembledBatch } from '../assemble/assembled-batch.js';
import { resolveObserveOptions } from '../observe-options.js';
import { encodeJob } from './job.encoder.js';

const ROOT_START = Date.parse('2026-01-01T00:00:10.000Z');

function options(spans = true) {
  return resolveObserveOptions({
    appKey: 'k',
    appSecret: 's',
    serviceId: 'flip-worker',
    include: { spans },
  });
}

function entry(type: string, content: unknown, overrides: Partial<Entry> = {}): Entry {
  return {
    id: `e-${type}`,
    batchId: 'batch-1',
    type,
    familyHash: null,
    content,
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'queue',
    instanceId: 'i1',
    traceId: null,
    spanId: null,
    createdAt: new Date(ROOT_START),
    ...overrides,
  } as Entry;
}

function jobRoot(content: Record<string, unknown> = {}, overrides: Partial<Entry> = {}): Entry {
  return entry(
    'job',
    {
      id: 'job-7',
      name: 'send-invoice',
      queue: 'emails',
      payload: { card: '4111111111111111' },
      status: 'completed',
      attempts: 2,
      maxAttempts: 5,
      waitMs: 400,
      failureReason: null,
      ...content,
    },
    { durationMs: 250, ...overrides },
  );
}

function batch(
  root: Entry | null,
  children: Entry[] = [],
  origin: BatchOrigin = 'queue',
): AssembledBatch {
  return { batchId: 'batch-1', origin, root, children };
}

describe('encodeJob', () => {
  it('returns null when the batch is not rooted at a job', () => {
    expect(encodeJob(batch(null), options())).toBeNull();
    expect(encodeJob(batch(entry('request', { method: 'GET', uri: '/' })), options())).toBeNull();
    expect(encodeJob(batch(entry('job', null)), options())).toBeNull();
  });

  it.each(['queued', 'processing', 'unknown', null])(
    'returns null for the non-terminal status %s',
    (status) => {
      expect(encodeJob(batch(jobRoot({ status })), options())).toBeNull();
    },
  );

  it('maps a completed run', () => {
    const job = encodeJob(batch(jobRoot()), options());

    // The entry is recorded once the run finished, so `c` is `createdAt` minus
    // the 250ms it ran, and `ea` is that start minus the 400ms it waited.
    expect(job).toEqual({
      i: 'job-7',
      s: 'completed',
      c: '2026-01-01T00:00:09.750Z',
      ti: 'batch-1',
      n: 'send-invoice',
      q: 'emails',
      d: 250,
      ea: '2026-01-01T00:00:09.350Z',
      wd: 400,
      am: 2,
      ma: 5,
      t: [],
    });
  });

  it('never carries the job payload', () => {
    expect(JSON.stringify(encodeJob(batch(jobRoot()), options()))).not.toContain('4111');
  });

  it('falls back to the batch id for both the job id and the trace id', () => {
    const job = encodeJob(batch(jobRoot({ id: null })), options());

    expect(job?.i).toBe('batch-1');
    expect(job?.ti).toBe('batch-1');
  });

  it('omits the enqueued time when the wait is unknown', () => {
    const job = encodeJob(batch(jobRoot({ waitMs: null })), options());

    expect(job).not.toHaveProperty('ea');
    expect(job).not.toHaveProperty('wd');
  });

  it('uses the schedule kind as the queue for a scheduled run', () => {
    const root = jobRoot(
      { id: null, name: 'nightly-sync', queue: 'schedule' },
      { origin: 'schedule', tags: ['schedule', 'schedule:cron', 'task:nightly-sync'] },
    );

    expect(encodeJob(batch(root, [], 'schedule'), options())?.q).toBe('schedule:cron');
  });

  it('keeps the recorded queue when a scheduled run carries no kind tag', () => {
    const root = jobRoot({ queue: 'schedule' }, { origin: 'schedule', tags: ['schedule'] });

    expect(encodeJob(batch(root, [], 'schedule'), options())?.q).toBe('schedule');
  });

  it('takes the error from a failure child and drops that child from the spans', () => {
    const job = encodeJob(
      batch(jobRoot({ status: 'failed', failureReason: 'timed out' }), [
        entry('query', { sql: 'SELECT 1' }, { id: 'q-1' }),
        entry(
          'exception',
          { class: 'TimeoutError', message: 'timed out after 30s', stack: null, context: {} },
          { id: 'exc-1' },
        ),
      ]),
      options(),
    );

    expect(job?.e).toEqual({ cls: 'TimeoutError', message: 'timed out after 30s' });
    expect(job?.t?.map((span) => span.n)).toEqual(['db.query']);
  });

  it('falls back to the failure reason when no exception was recorded', () => {
    const job = encodeJob(batch(jobRoot({ status: 'failed', failureReason: 'boom' })), options());

    expect(job?.e).toEqual({ message: 'boom' });
  });

  it('reports a failed run with neither an exception nor a reason without an error', () => {
    const job = encodeJob(batch(jobRoot({ status: 'failed', failureReason: null })), options());

    expect(job?.s).toBe('failed');
    expect(job).not.toHaveProperty('e');
  });

  it('leaves log children to the logs section and honours include.spans', () => {
    const children = [
      entry('log', { level: 'debug', message: 'tick', context: null }, { id: 'l-1' }),
      entry('redis', { command: 'GET', args: ['k'] }, { id: 'r-1' }),
    ];

    expect(encodeJob(batch(jobRoot(), children), options())?.t?.map((s) => s.n)).toEqual([
      'redis.GET',
    ]);
    expect(encodeJob(batch(jobRoot(), children), options(false))?.t).toEqual([]);
  });
});
