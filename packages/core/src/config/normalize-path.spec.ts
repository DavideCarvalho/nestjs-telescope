// packages/core/src/config/normalize-path.spec.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_TELESCOPE_PATH, normalizeTelescopePath } from './normalize-path.js';

describe('normalizeTelescopePath', () => {
  it('defaults to "telescope" when unset', () => {
    expect(normalizeTelescopePath()).toBe(DEFAULT_TELESCOPE_PATH);
    expect(normalizeTelescopePath()).toBe('telescope');
  });

  it('returns a clean segment unchanged', () => {
    expect(normalizeTelescopePath('observability')).toBe('observability');
  });

  it('strips leading and trailing slashes', () => {
    expect(normalizeTelescopePath('/observability/')).toBe('observability');
    expect(normalizeTelescopePath('///obs///')).toBe('obs');
  });

  it('falls back to the default for empty / slash-only / whitespace input', () => {
    expect(normalizeTelescopePath('')).toBe('telescope');
    expect(normalizeTelescopePath('/')).toBe('telescope');
    expect(normalizeTelescopePath('   ')).toBe('telescope');
  });

  it('preserves nested segments', () => {
    expect(normalizeTelescopePath('/admin/observability/')).toBe('admin/observability');
  });
});
