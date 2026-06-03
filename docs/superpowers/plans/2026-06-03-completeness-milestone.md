# Completeness Milestone — Telescope/Pulse parity

> subagent-driven. Order = priority. Commit per item, whole-repo green between items.

Driven by Davi "queremos tudo bora" + the perf diagnosis (analytics scans read full `content` JSON over the whole window → slow at volume; Laravel Pulse samples + pre-aggregates).

## STATUS (2026-06-03) — repo green: build 13/13, test 15/15, lint clean, 37 changesets
- ✅ A1 projection scans (`c4222b1`) — pulse/timeseries ~5x faster, two-pass hydration
- ✅ A2 prune/retention boot warning (`affd07e`)
- ✅ B4 request-detail waterfall (`e995e26`)
- ✅ B5 traces list page + `/traces` endpoint (`4892ef6`)
- ✅ B6 slow-request hotspots by route family (`c8596c8`) — requests now carry a normalized-route familyHash
- ✅ B7 free-text search over content (`bfc0e26`) — `EntryQuery.search`, all storages
- ✅ B8 exception grouping detail (`6817fe6`) — `/stats` exceptions groups + UI list/sparkline
- ✅ B9 live-tail pause/resume toggle (`c0804b9`)
- ⬜ **A3 rollups (the big one)** — ingest-time pre-aggregated period buckets (Pulse model); own design+build effort, NOT half-built. A1+A2 made the read-scan path fast enough for now; A3 is for true production scale.
- ⬜ B9 leftovers: retention controls surfaced in the UI (small; needs `meta` to expose prune); extra watchers (Redis commands / events / model changes) — each a NEW package like mail/cache/schedule.
- Pending: dogfood redeploy of A1/A2/B4–B9 to flip `telescope-local` (do when flip is stable on that branch — another agent has been branch-switching it). Repack core+ui, point flip deps, reboot.

## PERF FINDINGS (live, against flip's REMOTE dev RDS — 2026-06-03)
The dominant cost against a remote SQL store is **round-trip count**, not content size (flip's content is only ~819 B avg, so A1's projection win is marginal *there* — it matters when content is large).
- ✅ **Larger window page** (`80c8f97`, DEFAULT_PAGE_SIZE 500→5000) — the scan paginated in 500-row pages = ~10 sequential RTTs for 4700 rows. One big page → timeseries 4.3s→2.1s.
- ✅ **Prune is the big lever at volume** — flip's frontend polling floods ~780 rows/min. 15m retention = ~11k rows. Tightened to **5m** (`flip dd…`→5m) → 4700→**204 rows**; timeseries 0.9s, lists/traces **instant** (0.2s), no more "loading forever".
- ⬜ **NEXT perf win — batch the pulse hydration.** With few rows, pulse is still ~2.2s because its two-pass hydration issues **N individual `storage.find(id)` calls** (top-N slowest + exception reps + N+1 reps) = N remote RTTs. Fix: a single batched fetch (`EntryQuery.ids?: string[]` → `WHERE id IN (...)`, or a `findMany(ids)`), so hydration is ONE round-trip. Then pulse → ~1s.
- The real production answer remains **A3 rollups** (read pre-aggregated buckets, never scan raw rows).

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
