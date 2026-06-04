// packages/core/src/dump/telescope-dump.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTelescopeDump, telescopeDump } from './telescope-dump.js';

describe('telescopeDump global sink', () => {
  afterEach(() => {
    setTelescopeDump(null);
  });

  it('is a no-op before the sink is wired', () => {
    // No sink installed: must not throw.
    expect(() => telescopeDump({ a: 1 }, 'before')).not.toThrow();
  });

  it('forwards value + label to the sink once wired', () => {
    const sink = vi.fn();
    setTelescopeDump(sink);
    telescopeDump({ a: 1 }, 'label');
    expect(sink).toHaveBeenCalledWith({ a: 1 }, 'label');
  });

  it('stops forwarding after the sink is cleared', () => {
    const sink = vi.fn();
    setTelescopeDump(sink);
    setTelescopeDump(null);
    telescopeDump('x');
    expect(sink).not.toHaveBeenCalled();
  });
});
