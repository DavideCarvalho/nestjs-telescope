import type { Entry } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { isFailureEntry, toWireError } from './wire-error.js';

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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Entry;
}

describe('toWireError', () => {
  it('maps a server exception, class to cls', () => {
    const error = toWireError(
      entry('exception', {
        class: 'TypeError',
        message: 'x is not a function',
        stack: 'TypeError: x\n  at y',
        context: {},
      }),
    );

    expect(error).toEqual({
      cls: 'TypeError',
      message: 'x is not a function',
      stack: 'TypeError: x\n  at y',
    });
  });

  it('keeps only scalar context entries as tags', () => {
    const error = toWireError(
      entry('exception', {
        class: 'HttpException',
        message: 'boom',
        stack: null,
        context: {
          queue: 'emails',
          attempts: 2,
          retriable: false,
          payload: { card: '4111111111111111' },
          handler: () => undefined,
          missing: null,
        },
      }),
    );

    expect(error?.tags).toEqual({ queue: 'emails', attempts: 2, retriable: false });
    expect(error).not.toHaveProperty('stack');
  });

  it('truncates a long context value', () => {
    const error = toWireError(
      entry('exception', {
        class: 'E',
        message: 'm',
        stack: null,
        context: { blob: 'a'.repeat(900) },
      }),
    );

    expect((error?.tags?.blob as string).length).toBe(512);
    expect(error?.tags?.blob).toMatch(/…$/);
  });

  it('omits tags entirely rather than sending an empty map', () => {
    const error = toWireError(
      entry('exception', { class: 'E', message: 'm', stack: null, context: {} }),
    );

    expect(Object.keys(error ?? {})).not.toContain('tags');
  });

  it('maps a client exception, name to cls, and keeps url/release/userAgent', () => {
    const error = toWireError(
      entry('client_exception', {
        message: 'Cannot read properties of undefined',
        name: 'TypeError',
        stack: 'TypeError\n  at Widget',
        componentStack: 'x'.repeat(5000),
        url: 'https://app.test/orders',
        userAgent: 'Mozilla/5.0',
        user: { id: 7 },
        release: 'v1.2.3',
        extra: { formValues: { ssn: '000-00-0000' } },
        clientIp: '1.2.3.4',
      }),
    );

    expect(error?.cls).toBe('TypeError');
    expect(error?.tags).toEqual({
      url: 'https://app.test/orders',
      release: 'v1.2.3',
      userAgent: 'Mozilla/5.0',
    });
    expect(JSON.stringify(error)).not.toContain('ssn');
    expect(JSON.stringify(error)).not.toContain('componentStack');
  });

  it('falls back to the class when there is no message', () => {
    const error = toWireError(
      entry('exception', { class: 'TypeError', message: '', stack: null, context: {} }),
    );

    expect(error?.message).toBe('TypeError');
  });

  it('returns null for a nameless failure and for non-failure entries', () => {
    expect(
      toWireError(entry('exception', { class: '', message: '', stack: null, context: {} })),
    ).toBeNull();
    expect(toWireError(entry('query', { sql: 'SELECT 1' }))).toBeNull();
    expect(toWireError(entry('job', { status: 'failed' }))).toBeNull();
    expect(toWireError(entry('exception', null))).toBeNull();
  });
});

describe('isFailureEntry', () => {
  it('is true only for the two exception types', () => {
    expect(isFailureEntry(entry('exception', {}))).toBe(true);
    expect(isFailureEntry(entry('client_exception', {}))).toBe(true);
    expect(isFailureEntry(entry('job', {}, { tags: ['failed'] }))).toBe(false);
    expect(isFailureEntry(entry('request', {}, { tags: ['failed'] }))).toBe(false);
  });
});
