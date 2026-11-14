---
'@dudousxd/nestjs-telescope-ai': patch
'@dudousxd/nestjs-telescope-bullmq': patch
'@dudousxd/nestjs-telescope-cache': patch
'@dudousxd/nestjs-telescope-clickhouse': patch
'@dudousxd/nestjs-telescope-events': patch
'@dudousxd/nestjs-telescope-logs': patch
'@dudousxd/nestjs-telescope-mail': patch
'@dudousxd/nestjs-telescope-mikro-orm': patch
'@dudousxd/nestjs-telescope-mikro-orm-watcher': patch
'@dudousxd/nestjs-telescope-official': patch
'@dudousxd/nestjs-telescope-parquet': patch
'@dudousxd/nestjs-telescope-prisma': patch
'@dudousxd/nestjs-telescope-redis': patch
'@dudousxd/nestjs-telescope-redis-watcher': patch
'@dudousxd/nestjs-telescope-schedule': patch
'@dudousxd/nestjs-telescope-sqs': patch
'@dudousxd/nestjs-telescope-testing': patch
'@dudousxd/nestjs-telescope-typeorm': patch
'@dudousxd/nestjs-telescope-otel': patch
---

Accept `@dudousxd/nestjs-telescope` 5: the peer range adds `^5.0.0` (otel's becomes `^4.2.0 || ^5.0.0`, published as written rather than through `workspace:^`). Nothing else changes; the bullmq and sqs READMEs document the live jobs route's new `filter[state]` / `after` / `first` wire.
