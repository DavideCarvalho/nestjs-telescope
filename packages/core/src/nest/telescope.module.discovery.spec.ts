// packages/core/src/nest/telescope.module.discovery.spec.ts
import 'reflect-metadata';
import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { TelescopeModule } from './telescope.module.js';

describe('TelescopeModule discovery support', () => {
  it('exposes DiscoveryService so discovery-based watchers can resolve it', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ enabled: true, authorizer: () => true })],
    }).compile();

    const discovery = moduleRef.get(DiscoveryService, { strict: false });
    expect(discovery).toBeInstanceOf(DiscoveryService);
    expect(typeof discovery.getProviders).toBe('function');

    await moduleRef.close();
  });
});
