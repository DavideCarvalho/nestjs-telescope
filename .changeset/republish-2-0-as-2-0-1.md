---
"@dudousxd/nestjs-telescope-ai": patch
"@dudousxd/nestjs-telescope-bullmq": patch
"@dudousxd/nestjs-telescope-cache": patch
"@dudousxd/nestjs-telescope": patch
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
"@dudousxd/nestjs-telescope-testing": patch
"@dudousxd/nestjs-telescope-typeorm": patch
"@dudousxd/nestjs-telescope-ui": patch
---

Republish the 2.0 release as 2.0.1. The 2.0.0 versions on npm are an old accidental build from 2026-06-05 (deprecated at the time), so `changeset publish` skipped them as "already published" and `^2.0.0` installs that June build. 2.0.1 is the real 2.0: the first-party NestJS integration and route protection release, with no further changes.
