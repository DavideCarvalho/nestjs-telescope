---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-cache': minor
---

Add the cache watcher (`@dudousxd/nestjs-telescope-cache`). `CacheWatcher` wraps
a `cache-manager` `Cache`'s `get`/`set` (structural type — no hard dependency) to
capture hits/misses, correlated to the active request/job batch via the caller's
async context. `get` records `hit` (value present vs `undefined`/`null`) and
returns the value unchanged; `set` records `hit: null`. Core gains the `cache`
entry type (`EntryType.Cache`) and `CacheContent` (additive). Recording is
non-throwing and host errors are always re-thrown.
