---
'@dudousxd/nestjs-telescope-ui': minor
---

Add a Horizon-style Overview landing page (now the index route `#/`) with a stat
cards row (entries, requests, exceptions, jobs, jobs/min, failed jobs), a
throughput area chart, a by-type stacked-area chart, and recent-failures /
slowest lists linking to entry detail. Introduce dark-themed Recharts chart
primitives (`AreaChartCard`, `StackedAreaChartCard`, `BarChartCard` + shared
`chart-theme`), exported from `/react`, with all Recharts imports isolated to
`src/react/components/charts/*`. Re-skin the Pulse throughput-by-type and the
Queues failure-rate visualizations onto the new charts.
