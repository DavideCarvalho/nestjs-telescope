---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add exception grouping to the per-type stats insight. `summarizeStats` now
returns `exceptions?: ExceptionGroupStats[]` for the `exception` type: groups
the window's exception entries by family key (the entry's `familyHash`, or a
`${class}: ${message}` fallback when null) with `count`, `lastAt`, `class`,
`message`, and a per-bucket `overTime` series aligned to the report's buckets,
sorted by count desc then last-seen desc (top 8). The Exceptions view renders an
"Exception groups" list — class (mono), truncated message, count, relative
last-seen, and an inline over-time sparkline — each row drilling through to that
group's occurrences via `?familyHash=`.
