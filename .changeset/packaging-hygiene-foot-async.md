---
"@dudousxd/nestjs-telescope-ui": minor
"@dudousxd/nestjs-telescope-ai": patch
"@dudousxd/nestjs-telescope-bullmq": patch
"@dudousxd/nestjs-telescope-cache": patch
"@dudousxd/nestjs-telescope-events": patch
"@dudousxd/nestjs-telescope-logs": patch
"@dudousxd/nestjs-telescope-mail": patch
"@dudousxd/nestjs-telescope-mikro-orm": patch
"@dudousxd/nestjs-telescope-mikro-orm-watcher": patch
"@dudousxd/nestjs-telescope-otel": patch
"@dudousxd/nestjs-telescope-prisma": patch
"@dudousxd/nestjs-telescope-redis": patch
"@dudousxd/nestjs-telescope-redis-watcher": patch
"@dudousxd/nestjs-telescope-schedule": patch
"@dudousxd/nestjs-telescope-sqs": patch
"@dudousxd/nestjs-telescope-typeorm": patch
"@dudousxd/nestjs-telescope-testing": patch
---

Packaging hygiene + `TelescopeUiModule.forRootAsync`.

- `TelescopeUiModule` now exposes `forRootAsync({ imports, inject, useFactory, path })`, mirroring `TelescopeModule.forRootAsync`: dashboard options (`assetsDir`) are resolved via DI. As with the core module, the mount `path` is bound at module-build time and is passed statically on the config object (the static value also drives the serve-time asset-base rewrite, so it always matches the route).
- Added `"sideEffects"` to each publishable package to enable safe tree-shaking for downstream bundlers:
  - `false` on the pure watcher / helper / provider packages (ai, bullmq, cache, events, logs, mail, mikro-orm, mikro-orm-watcher, otel, prisma, redis, redis-watcher, sqs, typeorm, testing) — their entrypoints only re-export classes/types with no module-load side effects.
  - `["./dist/schedule.watcher.js"]` on schedule, which carries a load-bearing bare `import 'reflect-metadata'`.
  - `["./dist/server/*.js", "**/*.css"]` on ui, whose server module/controller emit decorator metadata at load and whose bundled SPA ships CSS.
  - core is left unmarked (treated as side-effecting) because its decorator metadata emit spans many directories.
