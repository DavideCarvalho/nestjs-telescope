---
"@dudousxd/nestjs-telescope-parquet": patch
---

Removing cold files now works on MinIO versions that reject `DeleteObjects` with `MissingContentMD5`: it falls back to single deletes and remembers.
