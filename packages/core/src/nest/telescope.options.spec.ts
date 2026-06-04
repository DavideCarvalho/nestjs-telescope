// packages/core/src/nest/telescope.options.spec.ts
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TELESCOPE_CONFIG, TELESCOPE_OPTIONS, TELESCOPE_STORAGE } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

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

describe('resolveUser option', () => {
  it('passes through the configured resolveUser hook to the service', () => {
    const resolveUser = (request: unknown): unknown => request;
    const service = new TelescopeService(resolveConfig({}), new InMemoryStorageProvider(), {
      resolveUser,
    });
    expect(service.resolveUser).toBe(resolveUser);
  });

  it('exposes undefined resolveUser when the host did not supply one', () => {
    const service = new TelescopeService(resolveConfig({}), new InMemoryStorageProvider(), {});
    expect(service.resolveUser).toBeUndefined();
  });
});
