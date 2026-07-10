// packages/core/src/nest/telescope-mount-paths.spec.ts
import { describe, expect, it } from 'vitest';
import { telescopeMountPaths } from './telescope-mount-paths.js';

describe('telescopeMountPaths', () => {
  it('defaults to the "telescope" mount', () => {
    expect(telescopeMountPaths()).toEqual(['telescope', 'telescope/{*splat}']);
  });

  it('honors a custom path', () => {
    expect(telescopeMountPaths('observability')).toEqual([
      'observability',
      'observability/{*splat}',
    ]);
  });

  it('normalizes leading/trailing slashes like normalizeTelescopePath', () => {
    expect(telescopeMountPaths('/observability/')).toEqual([
      'observability',
      'observability/{*splat}',
    ]);
    expect(telescopeMountPaths('///obs///')).toEqual(['obs', 'obs/{*splat}']);
  });

  it('preserves nested segments', () => {
    expect(telescopeMountPaths('/admin/observability/')).toEqual([
      'admin/observability',
      'admin/observability/{*splat}',
    ]);
  });

  it('falls back to the default for empty / slash-only / whitespace input', () => {
    expect(telescopeMountPaths('')).toEqual(['telescope', 'telescope/{*splat}']);
    expect(telescopeMountPaths('/')).toEqual(['telescope', 'telescope/{*splat}']);
    expect(telescopeMountPaths('   ')).toEqual(['telescope', 'telescope/{*splat}']);
  });
});
