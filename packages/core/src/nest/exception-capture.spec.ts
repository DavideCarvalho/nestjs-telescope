// packages/core/src/nest/exception-capture.spec.ts
import { BadRequestException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { RecordInput } from '../entry/entry.js';
import {
  captureException,
  isExpectedHttpControlFlow,
  toExceptionRecordInput,
} from './exception-capture.js';

/** Collect what the capture hands to `record`. */
function collector(): { recorded: RecordInput[]; record: (input: RecordInput) => void } {
  const recorded: RecordInput[] = [];
  return { recorded, record: (input) => recorded.push(input) };
}

describe('isExpectedHttpControlFlow', () => {
  it('skips a 4xx HttpException by default (control flow, not an incident)', () => {
    expect(isExpectedHttpControlFlow(new ForbiddenException('nope'), undefined)).toBe(true);
    expect(isExpectedHttpControlFlow(new BadRequestException('bad'), {})).toBe(true);
  });

  it('never skips a 5xx HttpException', () => {
    expect(
      isExpectedHttpControlFlow(new HttpException('gateway', HttpStatus.BAD_GATEWAY), undefined),
    ).toBe(false);
  });

  it('never skips a plain Error, whatever its message looks like', () => {
    expect(isExpectedHttpControlFlow(new Error('403 forbidden'), undefined)).toBe(false);
    expect(isExpectedHttpControlFlow('a thrown string', undefined)).toBe(false);
  });

  it('captures 4xx again under the captureHttp4xx escape hatch', () => {
    expect(
      isExpectedHttpControlFlow(new ForbiddenException('nope'), { captureHttp4xx: true }),
    ).toBe(false);
  });
});

describe('toExceptionRecordInput', () => {
  it('builds an exception entry with the name:message:frame family hash', () => {
    const input = toExceptionRecordInput(new TypeError('boom'));

    expect(input.type).toBe('exception');
    expect(input.familyHash).toMatch(/^TypeError:boom:at /);
    expect(input.content).toMatchObject({ class: 'TypeError', message: 'boom', context: {} });
    expect(input.content.stack).toContain('TypeError: boom');
  });

  it('normalises a non-Error throw so class/message are never empty', () => {
    const input = toExceptionRecordInput('just a string');

    expect(input.content.class).toBe('Error');
    expect(input.content.message).toBe('just a string');
  });

  it('carries the caller-supplied context and tags (the off-request "where")', () => {
    const input = toExceptionRecordInput(new Error('boom'), {
      context: { queue: 'mail', job: 'send' },
      tags: ['queue:mail'],
    });

    expect(input.content.context).toEqual({ queue: 'mail', job: 'send' });
    expect(input.tags).toEqual(['queue:mail']);
  });

  it('omits tags entirely when none are supplied', () => {
    expect(toExceptionRecordInput(new Error('boom')).tags).toBeUndefined();
  });

  // Same input, two doors: the family hash is the dashboard's grouping key, so
  // an identical throw must land in ONE family whether it came from a route or
  // from a job body. This is the whole reason the builder is shared.
  it('produces the same family hash regardless of which door supplied details', () => {
    const error = new TypeError('same bug');
    const fromRoute = toExceptionRecordInput(error);
    const fromJob = toExceptionRecordInput(error, { context: { queue: 'mail' } });

    expect(fromJob.familyHash).toBe(fromRoute.familyHash);
  });
});

describe('captureException', () => {
  it('records and reports true for a real error', () => {
    const { recorded, record } = collector();

    expect(captureException(record, new Error('boom'), undefined)).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  it('records nothing and reports false for skipped 4xx control flow', () => {
    const { recorded, record } = collector();

    expect(captureException(record, new ForbiddenException('nope'), undefined)).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  // Every caller is on the host's own failure path, about to re-throw the
  // original error. A throw from here would replace it — an observability bug
  // turning into a data-loss bug.
  it('swallows a throwing recorder instead of escaping to the caller', () => {
    const throwingRecord = (): void => {
      throw new Error('recorder boom');
    };

    expect(() => captureException(throwingRecord, new Error('boom'), undefined)).not.toThrow();
    expect(captureException(throwingRecord, new Error('boom'), undefined)).toBe(false);
  });

  it('swallows a hostile throw whose own stringification explodes', () => {
    const { recorded, record } = collector();
    const hostile = {
      toString(): string {
        throw new Error('nope');
      },
    };

    expect(() => captureException(record, hostile, undefined)).not.toThrow();
    expect(recorded).toHaveLength(0);
  });
});
