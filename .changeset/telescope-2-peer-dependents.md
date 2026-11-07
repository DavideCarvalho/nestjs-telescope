---
"@dudousxd/nestjs-telescope-ai": major
"@dudousxd/nestjs-telescope-bullmq": major
"@dudousxd/nestjs-telescope-cache": major
"@dudousxd/nestjs-telescope-events": major
"@dudousxd/nestjs-telescope-logs": major
"@dudousxd/nestjs-telescope-mail": major
"@dudousxd/nestjs-telescope-mikro-orm": major
"@dudousxd/nestjs-telescope-mikro-orm-watcher": major
"@dudousxd/nestjs-telescope-prisma": major
"@dudousxd/nestjs-telescope-redis": major
"@dudousxd/nestjs-telescope-redis-watcher": major
"@dudousxd/nestjs-telescope-schedule": major
"@dudousxd/nestjs-telescope-sqs": major
"@dudousxd/nestjs-telescope-testing": major
"@dudousxd/nestjs-telescope-typeorm": major
---

Requires `@dudousxd/nestjs-telescope@2`: the `@dudousxd/nestjs-telescope` peer range moves from `^1` to `^2`. No API of this package changes. Core 2.0 protects the console's routes only with `decorators` / `routes: false` (`@nestjs/authentication` + `@nestjs/authorization`) and refuses to boot in production without them; queue mutations (bullmq, sqs) are switched on with `mutations: true` instead of `authorizeAction`. See core's changelog for the migration.
