// packages/core/src/storage/safe-json.spec.ts
import { describe, expect, it } from 'vitest';
import { safeJsonParse } from './safe-json.js';

describe('safeJsonParse', () => {
  it('returns parsed value for valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeJsonParse('["x","y"]', [])).toEqual(['x', 'y']);
    expect(safeJsonParse('42', 0)).toBe(42);
  });

  it('returns fallback for garbage input', () => {
    expect(safeJsonParse('not json', { default: true })).toEqual({ default: true });
    expect(safeJsonParse('{broken', [])).toEqual([]);
    expect(safeJsonParse('', 'fallback')).toBe('fallback');
  });
});
