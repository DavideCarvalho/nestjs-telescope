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
1. **Defer the redaction walk to flush.** Capture context-dependent fields
   (batchId/sequence/traceId/spanId/timestamp) synchronously at `record()` (O(1)),
   push the RAW input, and run `redact()` + content-dependent taggers during the
   async flush. record() becomes a near-pure enqueue. Correctness gate: anything
   that reads async context (ALS batch, active OTel span) MUST stay at record()
   time; only the content walk moves. TDD with a test proving redaction still
   applied before store, and a test proving trace/batch captured at record time.
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

## Sequencing
C (5→6) first — directly answers the explicit ask, fully additive, low risk, gives
the measurement harness to prove A. Then A1 (biggest host-path win, guarded by C's
numbers). Then B3/B4 for read scale, A2/B sampling last.

## Execution
writing-plans → subagent-driven per workstream. Whole-repo green between items
(build 17/17, tests, lint). Dogfood to flip `telescope-local` after each workstream
(repack changed pkgs to fresh cache-bust tgz, reinstall, reboot, verify live).
No `as`/`unknown`; fixed versions; commit lib→main, flip→telescope-local; no push/publish without Davi's OK.
