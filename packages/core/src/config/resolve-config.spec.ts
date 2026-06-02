// packages/core/src/config/resolve-config.spec.ts
import { describe, expect, it } from 'vitest';
import { resolveConfig } from './resolve-config.js';

describe('resolveConfig', () => {
  it('fills defaults when given an empty object', () => {
    const config = resolveConfig({});
    expect(config.enabled).toBe(true);
    expect(config.recorder.bufferSize).toBeGreaterThan(0);
    expect(config.sampling).toEqual({});
    expect(typeof config.instanceId).toBe('string');
  });

  it('normalizes a global sampling number into a default rate', () => {
    const config = resolveConfig({ sampling: 0.5 });
    expect(config.sampling).toEqual({ default: 0.5 });
  });

  it('parses a string prune duration into milliseconds', () => {
    const config = resolveConfig({ prune: { after: '24h' } });
    expect(config.prune?.afterMs).toBe(24 * 60 * 60 * 1000);
  });

  it('rejects an out-of-range sampling rate', () => {
    expect(() => resolveConfig({ sampling: 2 })).toThrow();
  });
});
