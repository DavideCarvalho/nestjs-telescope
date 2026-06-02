---
'@dudousxd/nestjs-telescope-ui': minor
---

Complete the dashboard with Pulse (per-type counts, slowest entries, top
exceptions, N+1 hotspots) and Queues (throughput, failure rate, runtime/wait
percentiles) views, each with a window selector. Typed the `pulse()`/`queues()`
client responses and exported `PulsePanel`/`QueuesPanel`/`WindowSelect` at
`/react`. Added an e2e that serves the real built bundle.
