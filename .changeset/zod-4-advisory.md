---
'@dudousxd/nestjs-telescope': patch
---

Move to zod 4 for GHSA-mrhx-c7xc-m3w5, which has no patched 3.x. An app that overrode zod to 4 no longer loses the recorder defaults, which left a one-slot buffer and no flush interval.
