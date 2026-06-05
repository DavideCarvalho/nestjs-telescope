// packages/core/src/ai/diagnosis-cache.spec.ts
import { describe, expect, it } from 'vitest';
import { DiagnosisCache } from './diagnosis-cache.js';

describe('DiagnosisCache', () => {
  it('returns null on a miss and the markdown on a hit', () => {
    const cache = new DiagnosisCache();
    expect(cache.get('fam-A')).toBeNull();
    cache.set('fam-A', 'diagnosis');
    expect(cache.get('fam-A')).toBe('diagnosis');
    expect(cache.has('fam-A')).toBe(true);
  });

  it('expires entries after the TTL and treats an expired hit as a miss', () => {
    let now = 0;
    const cache = new DiagnosisCache({ ttlMs: 1000, now: () => now });
    cache.set('fam-A', 'd');
    now = 999;
    expect(cache.get('fam-A')).toBe('d');
    now = 1000;
    expect(cache.get('fam-A')).toBeNull();
    expect(cache.has('fam-A')).toBe(false);
  });

  it('evicts the oldest entry when over the cap', () => {
    const cache = new DiagnosisCache({ maxEntries: 2 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3'); // evicts 'a' (oldest)
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('3');
    expect(cache.size).toBe(2);
  });

  it('refreshing an entry moves it to the back of the eviction order', () => {
    const cache = new DiagnosisCache({ maxEntries: 2 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('a', '1b'); // refresh 'a' → 'b' is now the oldest
    cache.set('c', '3'); // evicts 'b'
    expect(cache.get('a')).toBe('1b');
    expect(cache.get('b')).toBeNull();
    expect(cache.get('c')).toBe('3');
  });
});
