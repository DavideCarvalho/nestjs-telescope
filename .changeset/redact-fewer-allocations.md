---
"@dudousxd/nestjs-telescope": patch
---

Redacting an entry's content allocates less. The bounded clone built a dotted path for every field
and lowercased every key, even when no paths were configured to mask; paths are now only built when
some are, and whether a key is masked is remembered (up to 4,096 keys per redaction spec). Fields are
read with `Object.keys` instead of `Object.entries`. The output is the same; the clone runs 10–15%
faster on durable-step and query content.
