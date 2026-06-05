// packages/core/src/nest/client-error-rate-limiter.spec.ts
import { describe, expect, it } from 'vitest';
import { ClientErrorRateLimiter } from './client-error-rate-limiter.js';

describe('ClientErrorRateLimiter', () => {
  it('allows up to perMinute requests then blocks', () => {
    const now = 0;
    const limiter = new ClientErrorRateLimiter({ perMinute: 3, now: () => now });
    expect(limiter.tryConsume('ip-1')).toBe(true);
    expect(limiter.tryConsume('ip-1')).toBe(true);
    expect(limiter.tryConsume('ip-1')).toBe(true);
    expect(limiter.tryConsume('ip-1')).toBe(false);
  });

  it('tracks buckets per IP independently', () => {
    const now = 0;
    const limiter = new ClientErrorRateLimiter({ perMinute: 1, now: () => now });
    expect(limiter.tryConsume('ip-a')).toBe(true);
    expect(limiter.tryConsume('ip-a')).toBe(false);
    // A different IP is unaffected.
    expect(limiter.tryConsume('ip-b')).toBe(true);
  });

  it('refills over time', () => {
    let now = 0;
    const limiter = new ClientErrorRateLimiter({ perMinute: 60, now: () => now });
    expect(limiter.tryConsume('ip')).toBe(true); // 59 left
    // Drain the rest.
    for (let i = 0; i < 59; i++) limiter.tryConsume('ip');
    expect(limiter.tryConsume('ip')).toBe(false);
    // 60/min = 1/sec; advance 1s → one token back.
    now += 1_000;
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(false);
  });

  it('evicts the oldest IP when over the tracked cap (bounded memory)', () => {
    const limiter = new ClientErrorRateLimiter({ perMinute: 1, maxTrackedIps: 2 });
    limiter.tryConsume('ip-1');
    limiter.tryConsume('ip-2');
    expect(limiter.size).toBe(2);
    // Inserting a third evicts the oldest (ip-1).
    limiter.tryConsume('ip-3');
    expect(limiter.size).toBe(2);
    // ip-1 was evicted, so it starts fresh (allowed again).
    expect(limiter.tryConsume('ip-1')).toBe(true);
  });

  it('never permanently locks out callers when misconfigured to 0/min', () => {
    const now = 0;
    const limiter = new ClientErrorRateLimiter({ perMinute: 0, now: () => now });
    // Treated as 1/min: the first request is allowed.
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(false);
  });
});
