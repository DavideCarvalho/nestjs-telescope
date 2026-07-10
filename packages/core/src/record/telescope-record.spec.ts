// packages/core/src/record/telescope-record.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTelescopeRecordSink, telescopeRecord } from './telescope-record.js';

describe('telescopeRecord global sink', () => {
  afterEach(() => {
    setTelescopeRecordSink(null);
  });

  it('is a no-op before the sink is wired', () => {
    // No sink installed: must not throw.
    expect(() => telescopeRecord({ type: 'query', content: { sql: 'select 1' } })).not.toThrow();
  });

  it('forwards the input to the sink once wired', () => {
    const sink = vi.fn();
    setTelescopeRecordSink(sink);
    const input = { type: 'query', content: { sql: 'select 1' } };
    telescopeRecord(input);
    expect(sink).toHaveBeenCalledWith(input);
  });

  it('stops forwarding after the sink is cleared', () => {
    const sink = vi.fn();
    setTelescopeRecordSink(sink);
    setTelescopeRecordSink(null);
    telescopeRecord({ type: 'query', content: {} });
    expect(sink).not.toHaveBeenCalled();
  });

  it('allows rebinding to a new sink', () => {
    const first = vi.fn();
    const second = vi.fn();
    setTelescopeRecordSink(first);
    setTelescopeRecordSink(second);
    telescopeRecord({ type: 'query', content: {} });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('drops re-entrant calls made from inside the sink (loop guard)', () => {
    const outer = vi.fn();
    const sink = vi.fn((input: { type: string; content: unknown }) => {
      outer(input);
      // Simulate a self-capturing host: recording triggers another record.
      telescopeRecord({ type: 'query', content: { nested: true } });
    });
    setTelescopeRecordSink(sink);
    telescopeRecord({ type: 'query', content: { nested: false } });
    expect(sink).toHaveBeenCalledTimes(1); // the nested call was dropped, not looped
    expect(outer).toHaveBeenCalledWith({ type: 'query', content: { nested: false } });
  });
});
