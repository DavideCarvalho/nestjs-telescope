// integration/memory-soak/src/soak.controller.ts
//
// The single endpoint the load driver hammers. Per request it reproduces the
// incident's capture volume: attaches the FAT circular `req.user` (read by the
// request middleware at `finish` and deep-cloned by redact), fires N cache
// hit/miss emits, records M query entries, and on a fraction of requests throws
// so the exception interceptor path runs too.

import { Controller, Get, Inject, InternalServerErrorException, Req } from '@nestjs/common';
import { buildFatUser } from './fat-user.js';
import { SoakBridge } from './soak-bridge.js';
import { SOAK_CONFIG, type SoakConfigToken } from './tokens.js';

interface MutableRequest {
  user?: unknown;
}

@Controller()
export class SoakController {
  private requestCounter = 0;

  constructor(
    private readonly bridge: SoakBridge,
    @Inject(SOAK_CONFIG) private readonly config: SoakConfigToken,
  ) {}

  @Get('/work')
  work(@Req() req: MutableRequest): { ok: true; n: number } {
    const requestIndex = this.requestCounter++;

    if (this.config.fatUser) {
      // The host's guards set a hydrated entity here before the finish callback.
      req.user = buildFatUser(requestIndex);
    }

    if (this.config.cacheEmitsPerRequest > 0) {
      this.bridge.emitCacheEvents(requestIndex, this.config.cacheEmitsPerRequest);
    }

    if (this.config.queryRecordsPerRequest > 0) {
      this.bridge.recordQueries(requestIndex, this.config.queryRecordsPerRequest);
    }

    // Throw on a fraction of requests so the exception watcher fires under load.
    if (this.config.exceptions && requestIndex % 17 === 0) {
      throw new InternalServerErrorException('synthetic soak failure');
    }

    return { ok: true, n: requestIndex };
  }
}
