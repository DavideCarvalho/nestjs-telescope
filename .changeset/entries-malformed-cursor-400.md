---
"@dudousxd/nestjs-telescope": patch
"@dudousxd/nestjs-telescope-testing": patch
---

`GET entries` (and `GET profiles`) now answer `400 Malformed cursor in "after"` to a cursor the shared `decodeCursor` cannot read, as the list API spec says, instead of silently returning the first page; every bundled storage (memory, SQLite, MikroORM, Redis, ClickHouse, tiered/Parquet) makes its cursors with `encodeCursor`, so their cursors keep working. `decodeCursor` is now strict (only the exact `encodeCursor` output decodes). The forward-only lists' unknown-parameter 400 no longer names `before` / `last` as accepted. The storage conformance suite checks that `nextCursor` decodes with `decodeCursor`.
