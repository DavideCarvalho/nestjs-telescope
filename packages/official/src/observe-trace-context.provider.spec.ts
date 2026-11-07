import { describe, expect, it } from 'vitest';
import {
  ObserveTraceContextProvider,
  syntheticSpanId,
  toW3cTraceId,
} from './observe-trace-context.provider.js';

describe('toW3cTraceId', () => {
  it('turns a UUID into its 32 hex digits', () => {
    expect(toW3cTraceId('4BF92F35-77B3-4DA6-A3CE-929D0E0E4736')).toBe(
      '4bf92f3577b34da6a3ce929d0e0e4736',
    );
  });

  it('keeps a bare 32-hex id, rejects the all-zero id and empty input', () => {
    expect(toW3cTraceId('4bf92f3577b34da6a3ce929d0e0e4736')).toBe(
      '4bf92f3577b34da6a3ce929d0e0e4736',
    );
    expect(toW3cTraceId('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(toW3cTraceId('')).toBeNull();
    expect(toW3cTraceId(null)).toBeNull();
    expect(toW3cTraceId(undefined)).toBeNull();
  });

  it('hashes a free-form x-request-id deterministically into 32 hex digits', () => {
    const a = toW3cTraceId('req-abc-123');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(toW3cTraceId('req-abc-123')).toBe(a);
    expect(toW3cTraceId('req-abc-124')).not.toBe(a);
  });
});

describe('ObserveTraceContextProvider', () => {
  it('reads currentTraceId() and adds a stable synthetic span id', () => {
    const provider = new ObserveTraceContextProvider({
      currentTraceId: () => '4bf92f35-77b3-4da6-a3ce-929d0e0e4736',
    });
    const ctx = provider.current();
    expect(ctx).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: syntheticSpanId('4bf92f3577b34da6a3ce929d0e0e4736'),
    });
    expect(ctx?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(provider.current()).toEqual(ctx);
  });

  it('follows the trace id as it changes between requests', () => {
    let id: string | null = '11111111-1111-1111-1111-111111111111';
    const provider = new ObserveTraceContextProvider({ currentTraceId: () => id });
    expect(provider.current()?.traceId).toBe('11111111111111111111111111111111');
    id = '22222222-2222-2222-2222-222222222222';
    expect(provider.current()?.traceId).toBe('22222222222222222222222222222222');
    id = null;
    expect(provider.current()).toBeNull();
  });

  it('never throws: no tracer, or a tracer that throws, gives null', () => {
    expect(new ObserveTraceContextProvider(undefined).current()).toBeNull();
    expect(
      new ObserveTraceContextProvider({
        currentTraceId: () => {
          throw new Error('no store');
        },
      }).current(),
    ).toBeNull();
  });
});
