---
"@dudousxd/nestjs-telescope-mikro-orm": minor
---

Add `telescopeManagedTables()`, returning the three tables
(`telescope_entries`, `telescope_rollups`, `telescope_schema_meta`) the
`MikroOrmStorageProvider` boot-manages. Consumers running their own MikroORM
CLI migrations against a shared database previously had to hand-maintain a
`/^telescope_/` regex (or an explicit list) in `skipTables` so a migration
diff never tried to drop telescope's tables — including the boot fingerprint
marker, which is easy to forget. `telescopeManagedTables()` derives the list
straight from the entities' own `tableName` metadata (never a hardcoded
parallel literal), so a future rename flows through automatically:

```ts
import { telescopeManagedTables } from '@dudousxd/nestjs-telescope-mikro-orm';

await MikroORM.init({
  // ...your entities/driver config
  schemaGenerator: { skipTables: telescopeManagedTables() },
});
```
