---
"@dudousxd/nestjs-telescope-ui": minor
---

Add a "Telescope health" card to the Overview page rendering `GET /health`:
per-capture cost (µs), buffer pressure + high-water, flush durations, and dropped
count (green when keeping up, red with an overflow/store breakdown when shedding).
Makes Telescope's own overhead visible at a glance.
