// packages/core/src/discovery/discovery.controller.ts
//
// `GET <path>/api/discovery?since=<version>&wait=<seconds>`: a control plane's app name → URL map,
// as the caller's tenant token may see it. Answered at once when `since` is not the current
// version, else held until the map changes (long poll), at most 30 s. Mounted on every app and a
// 404 unless the app is a control plane keeping a fleet. Not behind `authorize`: the tenant's
// token is its credential.
import {
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  NotFoundException,
  Query,
  Res,
} from '@nestjs/common';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from '../nest/telescope.options.js';
import { resolveTopology } from '../topology/config.js';
import { bearerToken } from '../topology/ingest.controller.js';
import type { VerifiedTenant } from '../topology/tenant-auth.js';
import type { DiscoveryMap } from './directory.js';
import { TelescopeDiscovery } from './discovery.service.js';
import { discoveryScopeOf } from './server.js';

/** Longest a `GET <path>/api/discovery` is held. */
const MAX_WAIT_S = 30;

interface ClosableResponse {
  once?(event: 'close', listener: () => void): unknown;
  raw?: { once?(event: 'close', listener: () => void): unknown };
}

@Controller('telescope/api/discovery')
export class TelescopeDiscoveryController {
  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TelescopeDiscovery) private readonly discovery: TelescopeDiscovery,
  ) {}

  @Get()
  async map(
    @Headers('authorization') authorization: unknown,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: ClosableResponse,
  ): Promise<DiscoveryMap> {
    const publisher = this.discovery.publisher;
    const topology = resolveTopology(this.options);
    if (publisher === null || topology.kind !== 'control-plane') throw new NotFoundException();
    const token = bearerToken(authorization);
    let tenant: VerifiedTenant | null;
    try {
      tenant = token === undefined ? null : await topology.verifyTenant({ token });
    } catch {
      throw new HttpException({ error: 'unavailable' }, 503);
    }
    if (tenant === null) throw new HttpException({ error: 'unauthorized' }, 401);
    const scope = discoveryScopeOf(tenant);
    if (scope === null) throw new HttpException({ error: 'forbidden' }, 403);
    const since = typeof query.since === 'string' && query.since !== '' ? query.since : null;
    const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(query.wait) || 0));
    // Stop holding the request when the tenant hangs up first.
    const hangUp = new AbortController();
    const raw = response.raw ?? response;
    raw.once?.('close', () => hangUp.abort());
    return publisher.wait(scope, since, wait * 1000, hangUp.signal);
  }
}
