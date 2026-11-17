---
'@dudousxd/nestjs-telescope': minor
---

Knobs to record fewer entries on busy apps. Defaults are unchanged (everything is recorded).

- `query.sampleRate` (0–1) keeps the queries of that fraction of traces, decided once per trace (or per request/job batch without one): a kept request keeps all of its queries, so its timeline and N+1 detection stay complete. `query.minMs` skips queries faster than the given ms. Queries tagged `slow` or `failed` are always recorded. `query.ignoreTables` drops statements on those tables (the first table a select reads, or the table an insert/update/delete writes; schema and quoting aside).
- `cache.hitSampleRate` (0–1, per trace) samples cache hits; misses, writes, deletes and clears are always recorded. `cache.ignoreStores` and `cache.ignoreKeys` (prefix strings / RegExps) drop operations on those stores or keys.
- `ignoreRequestPaths` (segment-boundary path prefixes / RegExps; blank strings are skipped) keeps the request middleware, and `telescopeRequestCapture`, from recording `request` entries for those paths. Queries made while serving them are still recorded.
- Rates are validated at boot. A sampled-out query is reported to the OpenTelemetry span processor like any other sampled-out entry.
