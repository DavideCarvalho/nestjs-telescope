---
'@dudousxd/nestjs-telescope-otel': minor
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-mikro-orm': minor
---

Add OpenTelemetry trace linking. The new `@dudousxd/nestjs-telescope-otel`
package implements core's `TraceContextProvider` SPI by reading the active
OpenTelemetry span via `@opentelemetry/api` (`OtelTraceContextProvider`,
optional peer, read-only — never creates or exports spans, degrades to `null`
when no span/API is present). Core gains the `TraceContextProvider` SPI,
`traceId`/`spanId` on each `Entry`, and a `meta.traceLink` template so the UI
can deep-link entries to a trace backend; the MikroORM storage provider adds the
corresponding trace columns so the ids survive persistence.
