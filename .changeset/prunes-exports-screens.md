---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
---

Add Prunes and Exports screens. The pruner now records every prune run (trigger,
duration, total deleted and real per-type deletions) in a bounded in-memory ring
exposed at `GET /prunes` alongside the resolved retention config and the predicted
next run; a new Prunes page surfaces that activity with per-type chips and a gated
"Prune now". A new Exports page exports filtered entries (by type / window /
search) to JSON or CSV entirely client-side, with a session export history and a
dependency-free CSV serializer.
