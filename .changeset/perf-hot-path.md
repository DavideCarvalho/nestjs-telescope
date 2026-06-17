---
"@dudousxd/nestjs-telescope": patch
---

perf: lighten the per-entry recorder path — compile the redaction key/path Sets once instead of rebuilding them per recorded entry, mutate tags in place in `enrich()` (dropping a full `Entry` clone), and honor the previously-dead `flushBatchSize` by chunking flushes.
