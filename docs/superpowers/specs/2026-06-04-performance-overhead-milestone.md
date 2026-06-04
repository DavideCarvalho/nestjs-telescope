# Performance, Scalability & Self-Overhead Milestone

**Goal (Davi, 2026-06-04):** the dashboard must stay fast at production volume,
and Telescope must NOT influence the host app's response time ("a pessoa coloca,
funciona, mas não impacta a performance do que já roda"). Plus: make Telescope's
own impact *visible* — measure and surface what it costs.

## Measured baseline (live, flip vs remote dev RDS, 2026-06-04)
- **Request capture is already off the critical path.** `telescopeRequestCapture`
  records inside `response.once('finish', …)` — fires AFTER the response is
  flushed. Host TTFB impact ≈ 0.
- **Query capture is the only thing on the hot path.** flip's MikroORM logger
  calls `recorder.record()` synchronously per query. `record()` runs `enrich()`
  (redaction object-walk + trace lookup + taggers + filter) then a ring-buffer
  push. No I/O — flush is an async timer. So per-query host cost = `enrich()`,
  dominated by the redaction walk over `{sql,bindings}`.
- **Read path already uses the Pulse rollup model.** `MikroOrmStorageProvider
  implements RollupStore`; `telescope_rollups` is populated (per-minute
  count/sum/max per metric); `timeseries` reads rollups → **0.21s** regardless of
  raw row count. `pulse` is **0.42s** because percentiles still scan raw rows.
- **The ~0.2s floor is remote-RDS RTT** (us-gov-west-1). One network round trip
  per query. Validated tradeoff — not relitigated here; the levers are
  round-trip COUNT and avoiding raw scans, not payload size.

## Workstreams

### A. Capture overhead → provably ~zero host impact
1. **❌ REJECTED — defer the redaction walk to flush (caused OOM).** Tried (lib
   `135d168`, reverted `45c466e`): moved redact+tag+filter to the async flush so
   `record()` only stashed RAW content. It built/tested green and dropped
   `captureCostNanos` ~8.7µs→~1µs, BUT crashed flip with a JS heap OOM (~4GB in
   ~3min under auth load). ROOT CAUSE: watcher content holds **live object graphs**
   — the request watcher captures `req.user`, a hydrated MikroORM entity that
   references its EntityManager + identity map + relations. Synchronous `redact()`
   was **load-bearing**: it snapshots content into a plain, reference-free object
   at `record()` time, releasing the ORM graph. Deferring it retained up to
   `bufferSize` live entity graphs until flush → memory blowup. **Lesson: redaction
   must stay synchronous; it doubles as a detach/snapshot that bounds memory.**
   The measured overhead is already negligible (requests off-path = 0; query
   capture ~8.7µs vs ms-scale query I/O; memory flat under load), so this lever
   wasn't needed. If capture cost ever matters, the safe levers are: capture
   LIGHTER content (project `req.user`→id/email instead of the entity), or make
   `redact()` itself faster — NOT deferral.
2. **Sane sampling default + docs.** Ship guidance (and optionally a default) to
   down-sample high-volume request floods. Requests are already off-path, so this
   is a STORE-volume/read-scale lever, not a latency one — frame it that way.

### B. Read path → scales past rollups
3. **Latency histogram rollups → percentile reads.** Add bucketed-latency rollups
   (p50/p95/p99 approximated from histogram buckets) so `pulse`/`stats` stop
   scanning raw rows for percentiles. Pulse then reads only rollups → flat cost.
4. **Cut round-trips.** pulse issues several sequential queries (each one RTT).
   Parallelize independent ones / fold into fewer queries. Wall-clock win on
   remote stores.

### C. Self-overhead visibility (the "ver o impacto" ask)
5. **Recorder self-metrics.** Instrument cumulative time-in-record() (host-path
   cost), records/sec, flush duration + frequency, buffer occupancy high-water,
   droppedCount (already tracked). Expose via a `/telescope/api/health` endpoint
   (+ `meta`). Zero added host cost (counters only).
6. **"Telescope health" UI card.** Surface #5: host-path µs/op, throughput, buffer
   pressure, flush p95, dropped. So a user can SEE Telescope costs ~X µs/query and
   0 ms/request, and that it's keeping up.

## STATUS (2026-06-04)
- ✅ **trace_id index** (`e707854`) — `#/traces/:id` was the only unindexed filter → full scan (~10s cold). Indexed in mikro-orm (self-heals via schema.update) + sqlite. Live on flip's MySQL.
- ✅ **C5 self-metrics + `GET /health`** (`10a3bc2`) — buffered count, ring high-water, flush durations, drops, on-demand `captureCostNanos`. Hot-path-safe. Live on flip.
- ✅ **C6 health UI card** (`d3ccf7d`, ui) — Overview card renders /health (µs/capture, buffer, flush, dropped). Live on flip (ui-ins8).
- ❌ **A1 deferred redaction — REJECTED** (`135d168`→revert `45c466e`): OOM via retained ORM entity graphs (see A.1 above). Lesson: sync redact is load-bearing.
- ✅ **Measured proof capture ≈ free**: requests off-path (0ms, finish-callback); query capture ~8.7µs; memory flat under load (sync `redact()` deep-clones enumerable props → drops the live EntityManager ref). So "capture must not slow the app" is MET and proven.
- ⬜ **B3 histogram-percentile rollups** — the ONE remaining read-path scale lever. pulse is 0.42s = 2 sequential remote-RDS RTTs (content-less window scan + 1 batched top-N hydrate; already 2-pass/batched, no cheap parallelization since pass 2 depends on pass 1). Only rollup-backed percentiles remove the raw scan. STORAGE-LAYER change → MUST be load-tested against flip under AUTH traffic before trusting (A1 lesson). Fresh context recommended.
- ⬜ **C6 done; B4 (fewer round-trips) — N/A**: pulse already 2-pass batched; timeseries already rollup-backed (0.21s flat).

## Sequencing
C (5→6) first — directly answers the explicit ask, fully additive, low risk, gives
the measurement harness to prove A. Then A1 (biggest host-path win, guarded by C's
numbers). Then B3/B4 for read scale, A2/B sampling last.

## Execution
writing-plans → subagent-driven per workstream. Whole-repo green between items
(build 17/17, tests, lint). Dogfood to flip `telescope-local` after each workstream
(repack changed pkgs to fresh cache-bust tgz, reinstall, reboot, verify live).
No `as`/`unknown`; fixed versions; commit lib→main, flip→telescope-local; no push/publish without Davi's OK.
