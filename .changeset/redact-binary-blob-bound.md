---
"@dudousxd/nestjs-telescope": patch
---

Bound binary payloads (Buffer/TypedArray/DataView/ArrayBuffer) in `redact()`
instead of walking them byte-by-byte. A `Buffer` is `typeof 'object'` and not an
`Array`, so it previously fell into the plain-object branch where
`Object.entries()` eagerly materializes one `[index, byte]` pair per byte BEFORE
the node/byte budgets are ever consulted. On a multi-MB body — e.g. a raw
file-upload chunk captured as a request entry's payload — that was seconds of
synchronous CPU and hundreds of MB allocated on the event loop, stalling every
concurrent request on the pod (the overload guard would log multi-second loop
lag after the damage was done). Binary values are now summarized as an O(1)
marker (`[Buffer: 8388608 bytes]`) and flagged as truncated, so redaction cost
is bounded regardless of body size.
