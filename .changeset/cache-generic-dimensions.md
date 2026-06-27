---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-cache": minor
"@dudousxd/nestjs-telescope-ui": minor
---

Make cache observability cache-agnostic and richer. `CacheContent` keeps its
universal core (`operation`/`key`/`hit`) and gains optional, vendor-neutral
dimensions any cache can map onto: `store`, `tier` (e.g. l1/l2), `stale`
(stale-while-revalidate / BentoCache grace), `ttlMs`, and a `metadata` escape
hatch. `operation` widens to include `delete`/`clear`. The cache watcher's
`{ instrument }` event carries these through (and surfaces store/tier/stale as
tags), and the auto-patch path now records the set TTL and wraps `del`/`delete`
so deletes are their own operation instead of being invisible or mislabelled.
The stats endpoint splits hits/misses by tier and counts stale hits + deletes,
and the Cache insights view renders per-tier hits, stale hits and delete counts;
the cache badge labels DEL/CLEAR and flags stale (amber) + tier. Simple caches
that don't supply the optional fields are unchanged.
