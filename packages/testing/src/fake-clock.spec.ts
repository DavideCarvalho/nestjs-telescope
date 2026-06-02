import { describe, expect, it } from 'vitest';
import { FakeClock } from './fake-clock.js';

describe('FakeClock', () => {
  it('returns 0 by default', () => {
    const clock = new FakeClock();
    expect(clock.now()).toBe(0);
  });

  it('returns the provided initial value', () => {
    const clock = new FakeClock(1000);
    expect(clock.now()).toBe(1000);
  });

  it('advance adds to the current time', () => {
    const clock = new FakeClock(100);
    clock.advance(50);
    expect(clock.now()).toBe(150);
  });

  it('advance is cumulative', () => {
    const clock = new FakeClock(0);
    clock.advance(100);
    clock.advance(200);
    expect(clock.now()).toBe(300);
  });

  it('set assigns an absolute time', () => {
    const clock = new FakeClock(999);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });
});
