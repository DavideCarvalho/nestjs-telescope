// integration/memory-soak/src/app.module.ts
//
// The minimal NestJS host that mirrors the incident's TelescopeModule wiring:
//  - storage from the cell (in-memory / sqlite / slow-storage), rollups toggled
//  - request + exception watchers (request via global app.use in bootstrap;
//    exception interceptor is auto-registered by TelescopeModule)
//  - a CacheWatcher driven by a custom `instrument` emitter (cache spam)
//  - per-request query records via the service (MikroORM-logger-shaped)
//  - prune on a short interval
//  - registerRequestMiddleware:false + global telescopeRequestCapture (incident)

import { TelescopeModule, type TelescopeModuleOptions } from '@dudousxd/nestjs-telescope';
import { CacheWatcher } from '@dudousxd/nestjs-telescope-cache';
import { type DynamicModule, Module } from '@nestjs/common';
import { CACHE_EMIT_HOLDER, CacheEmitHolder } from './cache-emit-holder.js';
import type { SoakConfig } from './config.js';
import { SoakBridge } from './soak-bridge.js';
import { SoakController } from './soak.controller.js';
import { buildStorage } from './storage-factory.js';
import { SOAK_CONFIG } from './tokens.js';

function readPruneAfter(): string {
  // Overridable so a soak can cross the prune horizon within minutes and observe
  // whether prune actually bounds retention. Default mirrors the incident (5m).
  const raw = process.env.SOAK_PRUNE_AFTER;
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : '5m';
}

function buildTelescopeOptions(
  config: SoakConfig,
  holder: CacheEmitHolder,
): TelescopeModuleOptions {
  const prune: TelescopeModuleOptions['prune'] = { after: readPruneAfter(), intervalMs: 2_000 };
  const options: TelescopeModuleOptions = {
    enabled: true,
    storage: buildStorage(config),
    // The incident registers capture globally in bootstrap, not as module middleware.
    registerRequestMiddleware: false,
    // Custom cache emitter — the highest-cardinality stream, fired per request.
    watchers: [new CacheWatcher(holder.source())],
    // Recorder: a short flush keeps the buffer turning over like the incident.
    recorder: { flushIntervalMs: 1_000 },
    // A real prune window on a short interval, like the incident's 5m/60s.
    ...(config.prune ? { prune } : {}),
  };
  return options;
}

@Module({})
export class AppModule {
  static forSoak(config: SoakConfig): DynamicModule {
    // One holder shared by the CacheWatcher source (closure) and the controller
    // (via DI) — no DI cycle with TelescopeModule's async options factory.
    const holder = new CacheEmitHolder();
    return {
      module: AppModule,
      imports: [
        TelescopeModule.forRootAsync({
          useFactory: () => buildTelescopeOptions(config, holder),
        }),
      ],
      controllers: [SoakController],
      providers: [
        SoakBridge,
        { provide: CACHE_EMIT_HOLDER, useValue: holder },
        {
          provide: SOAK_CONFIG,
          useValue: {
            fatUser: config.fatUser,
            cacheEmitsPerRequest: config.cacheEmitsPerRequest,
            queryRecordsPerRequest: config.queryRecordsPerRequest,
            exceptions: config.exceptions,
          },
        },
      ],
      exports: [SoakBridge],
    };
  }
}
