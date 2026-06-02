// packages/bullmq/src/job-content.spec.ts
import { describe, expect, it } from 'vitest';
import { buildJobContent } from './job-content.js';

describe('buildJobContent', () => {
  const baseJob = {
    id: 42,
    name: 'send-welcome-email',
    queueName: 'mail',
    attemptsMade: 1,
    opts: { attempts: 3 },
    data: { to: 'ada@example.com' },
    timestamp: 1000,
    processedOn: 1250,
  };

  it('builds a completed job content conforming to the core JobContent shape', () => {
    const content = buildJobContent(baseJob, 'completed', undefined, true);
    expect(content).toEqual({
      id: '42',
      name: 'send-welcome-email',
      queue: 'mail',
      payload: { to: 'ada@example.com' },
      status: 'completed',
      attempts: 1,
      maxAttempts: 3,
      waitMs: 250,
      failureReason: null,
    });
  });

  it('captures the failure reason from an Error and nulls it when completed', () => {
    const failed = buildJobContent(baseJob, 'failed', new Error('SMTP down'), true);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('SMTP down');
    expect(buildJobContent(baseJob, 'completed', undefined, true).failureReason).toBeNull();
  });

  it('stringifies non-Error failure values', () => {
    expect(buildJobContent(baseJob, 'failed', 'boom', true).failureReason).toBe('boom');
  });

  it('nulls payload when includeData is false but keeps the field present', () => {
    const content = buildJobContent(baseJob, 'completed', undefined, false);
    expect(content.payload).toBeNull();
    expect('payload' in content).toBe(true);
  });

  it('preserves falsy-but-valid id and attempts (0 is not dropped)', () => {
    const content = buildJobContent({ id: 0, attemptsMade: 0 }, 'completed', undefined, true);
    expect(content.id).toBe('0');
    expect(content.attempts).toBe(0);
  });

  it('computes waitMs from processedOn - timestamp, null when either is missing', () => {
    expect(buildJobContent({ timestamp: 1000, processedOn: 1700 }, 'completed', undefined, true).waitMs).toBe(700);
    expect(buildJobContent({ timestamp: 1000 }, 'completed', undefined, true).waitMs).toBeNull();
    expect(buildJobContent({ processedOn: 1700 }, 'completed', undefined, true).waitMs).toBeNull();
  });

  it('defaults missing fields (name/queue empty, attempts 0, id/maxAttempts null)', () => {
    const content = buildJobContent({}, 'completed', undefined, true);
    expect(content.id).toBeNull();
    expect(content.name).toBe('');
    expect(content.queue).toBe('');
    expect(content.attempts).toBe(0);
    expect(content.maxAttempts).toBeNull();
    expect(content.waitMs).toBeNull();
  });
});
