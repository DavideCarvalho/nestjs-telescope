import { describe, expect, it } from 'vitest';
import { buildTraceHref } from './trace-link.js';

describe('buildTraceHref', () => {
  it('substitutes both placeholders', () => {
    expect(
      buildTraceHref('https://tracing.example/{traceId}/spans/{spanId}', 'abc', 'def'),
    ).toBe('https://tracing.example/abc/spans/def');
  });

  it('substitutes every occurrence of a placeholder', () => {
    expect(buildTraceHref('{traceId}-{traceId}', 'x', 'y')).toBe('x-x');
  });

  it('returns null for a null template', () => {
    expect(buildTraceHref(null, 'abc', 'def')).toBeNull();
  });

  it('returns null for an empty template', () => {
    expect(buildTraceHref('', 'abc', 'def')).toBeNull();
  });
});
