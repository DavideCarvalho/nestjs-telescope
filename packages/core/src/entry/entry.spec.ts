// packages/core/src/entry/entry.spec.ts
import { describe, expect, it } from 'vitest';
import { EntryType, isBatchOrigin } from './entry.js';

describe('entry model', () => {
  it('exposes the built-in entry type constants', () => {
    expect(EntryType.Request).toBe('request');
    expect(EntryType.Query).toBe('query');
    expect(EntryType.Job).toBe('job');
    expect(EntryType.Exception).toBe('exception');
    expect(EntryType.Mail).toBe('mail');
  });

  it('recognizes valid batch origins', () => {
    expect(isBatchOrigin('http')).toBe(true);
    expect(isBatchOrigin('queue')).toBe(true);
    expect(isBatchOrigin('nonsense')).toBe(false);
  });
});
