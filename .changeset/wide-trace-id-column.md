---
'@dudousxd/nestjs-telescope-mikro-orm': patch
---

Widen `telescope_entries.trace_id` to VARCHAR(64): an explicit `RecordInput.traceId` can be a 36-char UUID (e.g. a durable runId), which the previous length-32 column silently truncated on MySQL — making the `#/traces/:id` waterfall lookup match nothing (404). Existing tables are realigned by the additive `schema.update` on the next boot.
