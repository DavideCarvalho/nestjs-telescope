---
'@dudousxd/nestjs-telescope': minor
---

The archiver keeps up with a backlog, and says when it cannot

- **A capped export resumes where it stopped.** When a type's archive hit `archive.maxBatchesPerCycle`, the next cycle started again from the newest doomed entries — so a backlog larger than one cycle handed the sink the same entries every cycle, never reached the oldest, and never deleted anything. The pruner now remembers the cutoff and cursor it stopped at, continues from there, and deletes under that cutoff once the export drains. Per process: a replica that takes over the prune lease starts its own export, which can repeat entries but never skips one.
- **Archive-backlog warning.** When the entries still waiting are older than twice their type's retention window, the pruner logs `archive backlog for type "<type>"` once per streak, naming the knobs to raise. It is the signal the [tiered storage](https://davidecarvalho.github.io/aviary/docs/telescope) docs point at.
