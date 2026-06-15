---
'@dudousxd/nestjs-telescope': minor
---

Add a `TelescopeExtension` SPI so libraries can contribute to the dashboard. Register extensions via `TelescopeModule.forRoot({ extensions: [...] })`; each may contribute watchers, navigable entry types, declarative dashboard pages (a neutral panel IR — `stat`/`timeseries`/`topN`/`table` — rendered natively by the UI, no extension React), and named server-side data providers served behind the existing read gate at `GET <path>/api/ext/:ext/data/:provider`. Entry types and dashboards surface dynamically in the nav via `/api/meta`. Authoring uses `defineTelescopeExtension(...)`; duplicate entry-type ids, dashboard ids, or provider names across extensions fail fast at boot. See the new "Extensions" concept page and the "Building an extension" recipe.
