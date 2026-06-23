---
"@dudousxd/nestjs-telescope-cache": patch
---

Lazy-import `@nestjs/cache-manager` so Bento-only consumers don't need the optional peer.

`@nestjs/cache-manager` is declared as an optional peer dependency, but `cache.watcher` did a top-level static `import { CACHE_MANAGER }` from it. That made merely loading the module (e.g. `import { CacheWatcher } from "@dudousxd/nestjs-telescope-cache"`) crash any app that doesn't install `@nestjs/cache-manager` with `ERR_MODULE_NOT_FOUND`, breaking Bento-only hosts that use only the `{ instrument }` path.

The runtime use of `CACHE_MANAGER` is now a dynamic `await import("@nestjs/cache-manager")`, deferred into the no-arg auto-discovery path (`resolveStandardCache`) — the only branch that needs it. The `{ instrument }` (Bento) and explicit-cache paths never load `@nestjs/cache-manager`. The token type is kept as an erased `import type`. `register()` returns a `Promise<void>` on the no-arg auto-discovery path.
