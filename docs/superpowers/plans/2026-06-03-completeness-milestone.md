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
- ✅ **Batched pulse hydration** (`6a4d8d5`) — `EntryQuery.ids?: string[]` (`WHERE id IN (...)`; redis uses MGET); pulse hydrate is now ONE query instead of N `find()`s. Live: pulse 2.2s→**1.46s cold / 0.42s warm**. Whole dashboard now snappy (pulse 0.4–1.5s, timeseries 0.9s, lists/traces/search 0.2s).
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

## BACKLOG EXECUTION (goal: "implementa a lista até o final") — 2026-06-03
DONE this run (all committed, green, build 17/17, lint clean):
- ✅ Schedule console (`b14a201`) — `#/schedules`, cron-expr + next/last run, ScheduleManager SPI
- ✅ Dumps (`b7326b3`) — `telescopeDump()` global sink, redacted, Dumps tab
- ✅ Events + Logs watchers (`7797a2a`) — 2 new pkgs (`-events`, `-logs`); EntryType.Event/Log + UI
- ✅ Model + Redis watchers (`6fa0946`) — 2 new pkgs (`-mikro-orm-watcher`, `-redis-watcher`); EntryType.Model/Redis + UI
- (earlier this milestone) A1 projection, A2 prune-warn, B4 waterfall, B5 traces, B6 slow-routes, B7 search, B8 exc-groups, B9 live-tail, batched-hydration, A3.1 rollup foundation, A3.2 mikro-orm rollups, tag-autocomplete, queue-enqueue, no-store cache fix

REMAINING (in priority order):
1. ⬜ A3 completion — redis RollupStore impl + pulse COUNTS read from rollups (percentiles stay raw two-pass)
2. ⬜ Zero-config auto-instrumentation — make CacheWatcher (CACHE_MANAGER token) auto-discover with no-arg ctor; `watch: {schedule,queues,events,cache}` toggles auto-add the discovery-based watchers (host passes classes, not resources). Mail/query lack standard tokens → keep explicit. Escape hatch (`instrument`) stays.
3. ⬜ Request detail rich — capture request payload + response body (body buffering in the request middleware) + auth user (optional host hook); UI detail shows headers/payload/response/user
4. ⬜ Pulse cards — slow outgoing HTTP hotspots (http_client by host, p99), server stats (cpu/mem/event-loop-lag), usage-by-user (needs a user-resolver hook)
5. ⬜ Polish — retention/sampling visible in UI (expose via meta), export entry/trace as JSON, light theme, command palette (Cmd+K)

NOTE: watcher SOURCE files picked up a `(v as {x:unknown}).x` narrowing pattern (events/mikro-orm-watcher) — mild drift from the no-`as` rule; clean up to type guards in a polish pass.
NOTE: flip dogfood is NOT redeployed with these new watchers/features yet (flip's branch was being switched by another agent); redeploy when stable.

## ✅ DOGFOOD REDEPLOY DONE & VERIFIED (2026-06-04)
Repacked + rewired flip `telescope-local` (flip commit `6998ff44`) to the completeness-milestone lib build. Fresh cache-bust tarballs in `~/personal/nestjs-telescope/packages/*/`: core=`core-ins10.tgz`, ui=`ui-ins7.tgz`, schedule=`schedule-ins2.tgz`, cache=`cache-ins.tgz`, mikro-orm=`mikro-orm-ins2.tgz` (bullmq/mail/otel/sqs unchanged). New wiring: `scheduleManagers:[scheduleWatcher]` (same ScheduleWatcher instance is both Watcher + ScheduleManager). events/logs watchers NOT wired — flip has no `@nestjs/event-emitter` (EventsWatcher would no-op) and LogsWatcher needs a logger swap (invasive/floody); skipped per scope.
- **Verified live on :3002** (boot log `/tmp/flip-dogfood-boot.log`, `RUN_MIGRATIONS=false OTEL_SERVICE_NAME=flip-nestjs pnpm start`): boot logs `Telescope schedule managers: 1`, `queue drivers: bullmq, sqs`, `watching: request,exception,mail,schedule,cache,cache`. `GET /telescope/api/schedules/live` → flip's 4 real crons w/ cron-expr+nextRunAt. `server-stats` → uptime/mem/cpu/event-loop. `meta` → retention 5m + traceLink. Request entry carries OTel traceId `69450b2d…` (resolves in Jaeger, 1 span) + rich content (ip/headers/user/method/status). index.html served `Cache-Control: no-store` with the freshly-built hash `index-BeJJEeUw.js` (no stale bundle). nest build exit 0.
- **App RUNNING** http://localhost:3002/telescope. Stop: `lsof -ti tcp:3002 | xargs kill`. Full revert: flip `git checkout master && git branch -D telescope-local && pnpm install`; `docker rm -f telescope-jaeger`.
- STILL PENDING (Davi's explicit OK only): `git push` lib to GitHub; npm publish.
