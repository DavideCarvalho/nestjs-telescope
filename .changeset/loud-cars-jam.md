---
"@dudousxd/nestjs-telescope-mikro-orm": patch
---

Widen `MikroOrmStorageProviderOptions` to `Partial<Options>` (was the full `Options`). The provider's own `buildOrmOptions()` already treated the connection config as partial — it forwards `source` to `MikroORM.init()` (whose own signature is `Partial<Options>`) and always overrides `entities` — so passing the minimal `{ driver, dbName }` shown in the docs and every test always worked at runtime but was rejected by the type checker. No behavior change.
