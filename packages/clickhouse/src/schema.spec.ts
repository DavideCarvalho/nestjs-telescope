import { describe, expect, it } from 'vitest';
import { assertIdentifier, entriesTtl, rollupsTtl, ttlFingerprint } from './schema.js';

describe('entriesTtl', () => {
  it('is a single unconditional rule without per-type overrides', () => {
    expect(entriesTtl({ default: '24h' })).toBe('toDateTime(created_at) + toIntervalSecond(86400)');
  });

  it('scopes each override to its type and carves them out of the default', () => {
    expect(entriesTtl({ default: '24h', perType: { exception: '90d', durable: '30d' } })).toBe(
      [
        "toDateTime(created_at) + toIntervalSecond(7776000) DELETE WHERE type = 'exception'",
        "toDateTime(created_at) + toIntervalSecond(2592000) DELETE WHERE type = 'durable'",
        "toDateTime(created_at) + toIntervalSecond(86400) DELETE WHERE type NOT IN ('exception', 'durable')",
      ].join(',\n  '),
    );
  });

  it('escapes type names', () => {
    expect(entriesTtl({ default: '1h', perType: { "it's": '2h' } })).toContain("type = 'it\\'s'");
  });

  it('rejects an invalid duration', () => {
    expect(() => entriesTtl({ default: 'forever' })).toThrow(/Invalid duration/);
    expect(() => entriesTtl({ default: 0 })).toThrow(/Invalid retention/);
  });
});

describe('rollupsTtl', () => {
  it('keeps buckets as long as the longest-kept type', () => {
    expect(rollupsTtl({ default: '1h', perType: { exception: '2d' } })).toBe(
      'toDateTime(bucket_start) + toIntervalSecond(172800)',
    );
  });
});

describe('ttlFingerprint', () => {
  it('changes with the TTL', () => {
    expect(ttlFingerprint('a')).not.toBe(ttlFingerprint('b'));
    expect(ttlFingerprint('a')).toBe(ttlFingerprint('a'));
  });
});

describe('assertIdentifier', () => {
  it('accepts plain and db-qualified names and rejects anything else', () => {
    expect(assertIdentifier('telescope_entries')).toBe('telescope_entries');
    expect(assertIdentifier('obs.telescope_entries')).toBe('obs.telescope_entries');
    expect(() => assertIdentifier('entries; DROP TABLE x')).toThrow();
  });
});
