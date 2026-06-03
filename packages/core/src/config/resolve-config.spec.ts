// packages/core/src/config/resolve-config.spec.ts
import { describe, expect, it } from 'vitest';
import type { TraceContextProvider } from '../trace/trace-context-provider.js';
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

  it('rejects prune.after of 0 (non-positive)', () => {
    expect(() => resolveConfig({ prune: { after: 0 } })).toThrow();
  });

  it('rejects prune.after of -1 (negative)', () => {
    expect(() => resolveConfig({ prune: { after: -1 } })).toThrow();
  });

  it('passes traceLink and traceContext through unchanged', () => {
    const traceContext: TraceContextProvider = { current: () => null };
    const config = resolveConfig({
      traceLink: 'https://traces.example/{traceId}/{spanId}',
      traceContext,
    });
    expect(config.traceLink).toBe('https://traces.example/{traceId}/{spanId}');
    expect(config.traceContext).toBe(traceContext);
  });

  it('defaults traceLink and traceContext to undefined when not given', () => {
    const config = resolveConfig({});
    expect(config.traceLink).toBeUndefined();
    expect(config.traceContext).toBeUndefined();
  });
});
