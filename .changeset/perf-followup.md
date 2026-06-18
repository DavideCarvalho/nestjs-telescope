---
"@dudousxd/nestjs-telescope": patch
---

perf: `runTaggers` fast-paths the no-taggers case (the common high-volume path), skipping the Set + result array + closure allocation while preserving the existing tag de-dup semantics.
