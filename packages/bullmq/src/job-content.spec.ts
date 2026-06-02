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
  };

  it('builds a completed job content with normalized fields', () => {
    const content = buildJobContent(baseJob, 'completed', undefined, true);
    expect(content).toEqual({
      id: '42',
      name: 'send-welcome-email',
      queue: 'mail',
      status: 'completed',
      attemptsMade: 1,
      maxAttempts: 3,
      failedReason: null,
      data: { to: 'ada@example.com' },
    });
  });

  it('captures the failure reason from an Error and omits it when completed', () => {
    const failed = buildJobContent(baseJob, 'failed', new Error('SMTP down'), true);
    expect(failed.status).toBe('failed');
    expect(failed.failedReason).toBe('SMTP down');
  });

  it('stringifies non-Error failure values', () => {
    const failed = buildJobContent(baseJob, 'failed', 'boom', true);
    expect(failed.failedReason).toBe('boom');
  });

  it('omits data entirely when includeData is false', () => {
    const content = buildJobContent(baseJob, 'completed', undefined, false);
    expect('data' in content).toBe(false);
  });

  it('normalizes missing optional fields to null', () => {
    const content = buildJobContent({}, 'completed', undefined, true);
    expect(content.id).toBeNull();
    expect(content.name).toBeNull();
    expect(content.queue).toBeNull();
    expect(content.attemptsMade).toBeNull();
    expect(content.maxAttempts).toBeNull();
  });
});
