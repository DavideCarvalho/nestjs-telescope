// packages/core/src/config/parse-duration.spec.ts
import { describe, expect, it } from 'vitest';
import { durationToMs } from './parse-duration.js';

describe('durationToMs', () => {
  it('passes through a number unchanged', () => {
    expect(durationToMs(1500)).toBe(1500);
  });

  it('parses unit suffixes', () => {
    expect(durationToMs('500ms')).toBe(500);
    expect(durationToMs('30s')).toBe(30_000);
    expect(durationToMs('15m')).toBe(900_000);
    expect(durationToMs('2h')).toBe(7_200_000);
    expect(durationToMs('1d')).toBe(86_400_000);
  });

  it('trims surrounding whitespace', () => {
    expect(durationToMs(' 1h ')).toBe(3_600_000);
  });

  it('throws on an invalid duration string', () => {
    expect(() => durationToMs('soon')).toThrow('Invalid duration: soon');
    expect(() => durationToMs('10x')).toThrow('Invalid duration: 10x');
  });
});
