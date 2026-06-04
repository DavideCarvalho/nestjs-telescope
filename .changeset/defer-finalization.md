---
"@dudousxd/nestjs-telescope": minor
---

Make data capture near-zero cost on the host's critical path: `Recorder.record()`
now only does cheap, async-context-dependent work (sampling, batch/sequence/trace
capture) and buffers the entry with RAW content. The heavy per-entry work —
redaction, tagging, and the user filter — is deferred to the asynchronous
`flush()`, off the host app's request/query path. Behavior is unchanged (redact →
tag → filter run in the same order, just later); stored entries are still redacted
and tagged. Benefits every watcher (query/cache/mail/…) at once.
