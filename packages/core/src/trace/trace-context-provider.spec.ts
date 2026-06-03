// packages/core/src/trace/trace-context-provider.spec.ts
import { describe, expect, it } from 'vitest';
import type { TraceContext, TraceContextProvider } from './trace-context-provider.js';

describe('TraceContextProvider contract', () => {
  it('a provider may resolve a concrete TraceContext', () => {
    const context: TraceContext = { traceId: 'trace-1', spanId: 'span-1' };
    const provider: TraceContextProvider = {
      current() {
        return context;
      },
    };

    const resolved = provider.current();

    expect(resolved).toEqual({ traceId: 'trace-1', spanId: 'span-1' });
  });

  it('a provider returns null when there is no active span', () => {
    const provider: TraceContextProvider = {
      current() {
        return null;
      },
    };

    expect(provider.current()).toBeNull();
  });
});
