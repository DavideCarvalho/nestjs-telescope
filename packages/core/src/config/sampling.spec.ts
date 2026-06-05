// packages/core/src/config/sampling.spec.ts
import { describe, expect, it } from 'vitest';
import { EntryType, type RecordInput } from '../entry/entry.js';
import { isErrorEntry, passesSampling } from './sampling.js';

function logEntry(level: string): RecordInput {
  return {
    type: EntryType.Log,
    content: { level, message: 'm', context: null },
  };
}

describe('isErrorEntry', () => {
  it('treats a "failed" tag as an error', () => {
    expect(isErrorEntry({ type: EntryType.Request, content: {}, tags: ['failed'] })).toBe(true);
  });

  it('treats content.failed === true as an error', () => {
    expect(isErrorEntry({ type: EntryType.Request, content: { failed: true } })).toBe(true);
  });

  it('treats statusCode >= 500 as an error but not 4xx', () => {
    expect(isErrorEntry({ type: EntryType.Request, content: { statusCode: 503 } })).toBe(true);
    expect(isErrorEntry({ type: EntryType.Request, content: { statusCode: 404 } })).toBe(false);
  });

  it('treats warn/error/fatal log levels as errors', () => {
    expect(isErrorEntry(logEntry('warn'))).toBe(true);
    expect(isErrorEntry(logEntry('error'))).toBe(true);
    expect(isErrorEntry(logEntry('fatal'))).toBe(true);
  });

  it('does not treat log/debug/verbose levels as errors', () => {
    expect(isErrorEntry(logEntry('log'))).toBe(false);
    expect(isErrorEntry(logEntry('debug'))).toBe(false);
    expect(isErrorEntry(logEntry('verbose'))).toBe(false);
  });

  it('returns false for a non-object content', () => {
    expect(isErrorEntry({ type: EntryType.Log, content: null })).toBe(false);
  });
});

describe('passesSampling with level-aware keepErrors', () => {
  it('always keeps a warn/error log even at rate 0', () => {
    const sampling = { log: { rate: 0, keepErrors: true } };
    // random would otherwise drop everything at rate 0.
    expect(passesSampling(sampling, logEntry('warn'), () => 0.99)).toBe(true);
    expect(passesSampling(sampling, logEntry('error'), () => 0.99)).toBe(true);
  });

  it('samples non-error logs by the base rate', () => {
    const sampling = { log: { rate: 0, keepErrors: true } };
    expect(passesSampling(sampling, logEntry('log'), () => 0.5)).toBe(false);
  });
});
