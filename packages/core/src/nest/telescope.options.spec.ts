// packages/core/src/nest/telescope.options.spec.ts
import { describe, expect, it } from 'vitest';
import { TELESCOPE_CONFIG, TELESCOPE_OPTIONS, TELESCOPE_STORAGE } from './telescope.options.js';

describe('DI tokens', () => {
  it('TELESCOPE_OPTIONS, TELESCOPE_STORAGE, and TELESCOPE_CONFIG are three distinct symbols', () => {
    expect(typeof TELESCOPE_OPTIONS).toBe('symbol');
    expect(typeof TELESCOPE_STORAGE).toBe('symbol');
    expect(typeof TELESCOPE_CONFIG).toBe('symbol');
    expect(TELESCOPE_OPTIONS).not.toBe(TELESCOPE_STORAGE);
    expect(TELESCOPE_OPTIONS).not.toBe(TELESCOPE_CONFIG);
    expect(TELESCOPE_STORAGE).not.toBe(TELESCOPE_CONFIG);
  });
});
