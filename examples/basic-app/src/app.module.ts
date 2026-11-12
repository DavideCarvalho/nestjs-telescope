// The whole app, wired in one place:
//  - TelescopeModule.forRoot({}) — zero-config, defaults to an in-memory SQLite
//    store, the request + exception watchers, and the headless /telescope/api.
//  - TelescopeUiModule.forRoot({ authorize }) — serves the React dashboard at /telescope.
//  - A CacheWatcher fed by a custom emitter (per-request hit/miss).
//  - The coffee endpoints + the traffic seeder that fills the dashboard for you.

import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { CacheWatcher } from '@dudousxd/nestjs-telescope-cache';
import { TelescopeUiModule } from '@dudousxd/nestjs-telescope-ui';
import { Module } from '@nestjs/common';
import { CACHE_EMIT_HOLDER, CacheEmitHolder } from './cache-emit-holder.js';
import { CoffeeController } from './coffee.controller.js';
import { CoffeeService } from './coffee.service.js';
import { TrafficSeederService } from './traffic-seeder.service.js';

// One holder, shared by the CacheWatcher source (closure, registered at boot)
// and the CoffeeService (via DI). Sharing by reference avoids a DI cycle with
// TelescopeModule's options factory.
const cacheHolder = new CacheEmitHolder();

// The demo's console check, shared by the API and the dashboard page.
const consoleAccess = () => process.env.NODE_ENV !== 'production';

@Module({
  imports: [
    TelescopeModule.forRoot({
      // Zero-config: in-memory SQLite, request + exception watchers on by default.
      // Just add the one custom watcher this demo drives by hand.
      watchers: [new CacheWatcher(cacheHolder.source())],

      // Who may use the console (API, live stream, MCP). The demo has no sign-in,
      // so it opens the console outside production only; a real app checks its
      // user here, e.g. `ctx.switchToHttp().getRequest().user?.isAdmin === true`.
      authorize: consoleAccess,
    }),
    TelescopeUiModule.forRoot({ authorize: consoleAccess }),
  ],
  controllers: [CoffeeController],
  providers: [
    CoffeeService,
    TrafficSeederService,
    { provide: CACHE_EMIT_HOLDER, useValue: cacheHolder },
  ],
})
export class AppModule {}
