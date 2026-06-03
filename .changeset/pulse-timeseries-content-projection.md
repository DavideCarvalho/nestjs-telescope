---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-mikro-orm': patch
---

Speed up the `/pulse` and `/timeseries` analytics endpoints by aggregating over
a content-less projection instead of reading every entry's heavy `content` JSON
blob.

`EntryQuery` gains an `omitContent?: boolean` flag. When set, `get()` returns
entries with `content: null` and the provider skips reading/parsing the content
column where its driver allows:

- **mikro-orm**: projects every persisted column EXCEPT `content` via MikroORM's
  `fields` option, so the blob never leaves the database (the main win on MySQL).
- **sqlite**: SELECTs the content-less column list and skips JSON parsing.
- **in-memory**: returns shallow copies with `content` nulled.
- **redis**: stores the whole entry as one blob, so it must read it anyway —
  `omitContent` nulls `content` after parse (correct, but no projection benefit).

`timeseries` now scans content-less (bucketing only needs `createdAt`/`type`).
`pulse` runs two passes: pass 1 aggregates the whole window content-less
(counts, slowest candidates, exception families, N+1 hotspots); pass 2 hydrates
`content` for ONLY the few displayed rows (top-N slowest, one representative per
reported exception family, one per reported N+1 family) via targeted `find`s.
The pulse output shape is unchanged.

At ~10k entries with large content blobs this drops pulse and timeseries from
several seconds to a fraction of a second.
