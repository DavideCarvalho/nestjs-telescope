import type { Entry } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { MAX_LOG_TEXT_LENGTH, encodeLog } from './log.encoder.js';

const AT = Date.parse('2026-01-01T00:00:00.000Z');

function entry(type: string, content: unknown, overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    batchId: 'b1',
    type,
    familyHash: null,
    content,
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i1',
    traceId: null,
    spanId: null,
    createdAt: new Date(AT),
    ...overrides,
  } as Entry;
}

describe('encodeLog', () => {
  it('maps a log entry onto the long-key wire shape', () => {
    const log = encodeLog(
      entry(
        'log',
        { level: 'WARN', message: 'disk almost full', context: 'HealthService' },
        { traceId: 'trace-1', spanId: 'span-1' },
      ),
    );

    expect(log).toEqual({
      timestamp: AT,
      text: 'disk almost full',
      traceId: 'trace-1',
      spanId: 'span-1',
      level: 'warn',
      context: 'HealthService',
    });
  });

  it('omits context and level rather than nulling them', () => {
    const log = encodeLog(entry('log', { level: '', message: 'hi', context: null }));

    expect(log).toEqual({ timestamp: AT, text: 'hi', traceId: 'b1' });
    expect(log).not.toHaveProperty('spanId');
  });

  it('correlates on the batch id when nothing provides a trace id', () => {
    // Without an OTel provider every entry's traceId is null, and a log with no
    // trace id cannot be shown against the request that emitted it. The
    // snapshot falls back to the batch id for `ti`, so this has to match.
    const log = encodeLog(entry('log', { level: 'log', message: 'hi', context: null }));

    expect(log?.traceId).toBe('b1');
  });

  it('prefers a real trace id over the batch id', () => {
    const log = encodeLog(
      entry('log', { level: 'log', message: 'hi', context: null }, { traceId: 'trace-9' }),
    );

    expect(log?.traceId).toBe('trace-9');
  });

  it('caps the text and marks the cut', () => {
    const log = encodeLog(entry('log', { level: 'log', message: 'x'.repeat(9000), context: null }));

    expect(log?.text.length).toBe(MAX_LOG_TEXT_LENGTH);
    expect(log?.text.endsWith('… [truncated]')).toBe(true);
  });

  it('leaves a message that exactly fits untouched', () => {
    const message = 'y'.repeat(MAX_LOG_TEXT_LENGTH);
    expect(encodeLog(entry('log', { level: 'log', message, context: null }))?.text).toBe(message);
  });

  it('returns null for anything that is not a usable log entry', () => {
    expect(encodeLog(entry('query', { sql: 'SELECT 1' }))).toBeNull();
    expect(encodeLog(entry('log', null))).toBeNull();
    expect(encodeLog(entry('log', { level: 'log', message: '', context: null }))).toBeNull();
    expect(
      encodeLog(
        entry(
          'log',
          { level: 'log', message: 'hi', context: null },
          { createdAt: new Date(Number.NaN) },
        ),
      ),
    ).toBeNull();
  });
});
