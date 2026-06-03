# Completeness Milestone — Telescope/Pulse parity

> subagent-driven. Order = priority. Commit per item, whole-repo green between items.

Driven by Davi "queremos tudo bora" + the perf diagnosis (analytics scans read full `content` JSON over the whole window → slow at volume; Laravel Pulse samples + pre-aggregates).

## STATUS (2026-06-03)
- ✅ A1 projection scans (`c4222b1`) — pulse/timeseries ~5x faster, two-pass hydration
- ✅ A2 prune/retention boot warning (`affd07e`)
- ✅ B4 request-detail waterfall (`e995e26`)
- ✅ B5 traces list page + `/traces` endpoint (`4892ef6`)
- ⬜ B6 slow-request hotspots · ⬜ B7 free-text search · ⬜ B8 exception grouping detail · ⬜ B9 polish/watchers · ⬜ A3 rollups (the big one)
- Pending: dogfood redeploy of all the above to flip `telescope-local` (blocked while another agent branch-switches flip).

## A. PERFORMANCE (foundational — do first)
1. **Projection-only analytics scans** — pulse/timeseries (and stats where possible) must NOT read the `content` JSON blob. Add an `omitContent`/projection path to the window scan + storage `get` so aggregates read only type/family_hash/duration_ms/created_at/sequence/batch_id/status. Benchmark before/after. (core + storages: mikro-orm, sqlite, redis, in-memory)
2. **Sampling + prune defaults + warning** — ship a sane default `prune` (or a boot warning when unset), and document/enable per-type `sampling` for noisy request floods (Pulse model). (core options + resolve-config + a startup log)
3. **(big, optional) Rollups** — Pulse-style pre-aggregated period buckets written on ingest; dashboard reads rollups not raw scans. Defer unless 1+2 insufficient.

## B. FEATURES
4. **Request-detail waterfall** — entry detail for a request shows its batch (child queries/cache/jobs) inline, ordered by start, with a duration bar per child (mini timeline). Uses the existing batch. (ui, maybe a batch-with-timing endpoint)
5. **Traces list page** — `#/traces` browses recent distinct traceIds (count + types + time), each → the existing `#/traces/:id`. Needs a storage "distinct traces in window" query + a nav entry. (core + ui)
6. **Slow-request hotspots** — pulse adds slow-endpoint hotspots (aggregate request entries by uri/route, p99 + count), mirroring N+1. (core pulse + ui)
7. **Free-text search** — `EntryQuery.search` over uri/sql (LIKE), wired to the entries filter bar. (core + storages + controller + ui)
8. **Exception grouping detail** — exception entries grouped by class+message with occurrences-over-time + a representative stack; a detail view. (core + ui)
9. **Polish** — live-tail toggle (pause/resume polling), retention controls surfaced in the UI, and extra watchers (Redis commands, events, model/entity changes) as separate smaller pieces.

## Dogfood
Batch a single core+ui repack/redeploy to flip `telescope-local` after a few items land (not per-item). Keep the 15m prune.
