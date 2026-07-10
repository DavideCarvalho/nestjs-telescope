---
"@dudousxd/nestjs-telescope-mikro-orm": patch
---

`telescopeMikroOrmLogger` accepts options as the first argument for the zero-config case — `telescopeMikroOrmLogger({ slowMs: 100 })` instead of `telescopeMikroOrmLogger(undefined, { slowMs: 100 })`.
