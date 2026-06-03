# OTel Span Linking — Design

**Date:** 2026-06-03
**Status:** Approved (Davi pre-approved the shape; first-class fields resolved per his recommendation)

## Goal

When an OpenTelemetry span is active at the moment Telescope records an entry,
stamp the entry with the active span's `traceId` and `spanId`. Surface those in
the dashboard so a captured request/query/job/etc. links back to its distributed
trace (Grafana Tempo / Jaeger / Honeycomb / …) via a clickable, configurable URL.

This is **read-only correlation**: Telescope reads the ambient span; it does NOT
create, mutate, or export spans. Bidirectional OTel (export entries as spans,
ingest spans as entries) is explicitly out of scope — a later phase of `-otel`.

## Why first-class fields (not tags)

Two storage-agnostic options were considered:

1. **First-class `Entry.traceId` / `Entry.spanId`** (chosen). Clean typed access,
   straightforward UI rendering, indexable later. Costs a small additive schema
   change in the SQL-backed storages.
2. `tags: ['trace:<id>']`. Zero schema change, but overloads the tag system
   (pollutes the tag filter / tag-count UI), needs string parsing to render, and
   can't carry both ids cleanly.

First-class wins: the schema change is purely additive and the self-healing
storages absorb it at boot with no migration. Davi's instruction ("Recorder
anexa traceId/spanId") matches first-class.

## Architecture

```
@opentelemetry/api  ──(active span)──►  OtelTraceContextProvider   (packages/otel)
                                              │ implements
                                              ▼
                                    TraceContextProvider SPI        (packages/core)
                                              │ current(): TraceContext | null
                                              ▼
                                         Recorder.enrich()          (packages/core)
                                              │ stamps traceId/spanId onto Entry
                                              ▼
                                    StorageProvider.store()         (in-memory / sqlite / redis / mikro-orm)
                                              │ persists the two new fields
                                              ▼
                                    GET /telescope/api/entries/:id  ──► UI entry detail
                                                                          shows Trace row + clickable link
```

### SPI (core, new) — `packages/core/src/trace/trace-context-provider.ts`

```ts
/** A snapshot of the currently-active distributed-trace position. */
export interface TraceContext {
  traceId: string;
  spanId: string;
}

/**
 * Resolves the ambient trace context at record time. Optional integration point.
 * Implementations MUST be cheap (called on every recorded entry) and MUST NOT
 * throw — return null when no span is active or the tracer is unavailable.
 */
export interface TraceContextProvider {
  current(): TraceContext | null;
}
```

### Entry shape (core) — additive

`Entry` gains:

```ts
  traceId: string | null;
  spanId: string | null;
```

`RecordInput` is **unchanged** — these are enrichment-only fields, not
watcher-supplied. Every existing test/factory that builds an `Entry` literal
must add `traceId: null, spanId: null` (or a shared test factory default).

### Recorder enrichment

`RecorderOptions` gains `traceContext?: TraceContextProvider`. In `enrich()`:

```ts
const trace = this.options.traceContext?.current() ?? null;
// ...inside the base Entry literal:
traceId: trace?.traceId ?? null,
spanId: trace?.spanId ?? null,
```

`record()` already wraps everything in a try/catch that swallows into a
`record-error` drop, so a misbehaving provider can never break the host. The
provider is *also* internally defensive (below).

### Config / options wiring

- `TelescopeCoreOptions` (and therefore `TelescopeModuleOptions`) gain:
  - `traceContext?: TraceContextProvider`
  - `traceLink?: string` — a URL template with `{traceId}` / `{spanId}`
    placeholders, e.g. `https://grafana.internal/explore?traceId={traceId}`.
    UI-only; surfaced via the meta endpoint. When absent the UI shows the ids as
    plain copyable text.
- `ResolvedCoreConfig` carries `traceContext?` through (passed to the Recorder)
  and `traceLink?: string` (surfaced via meta). `resolve-config` defaults both to
  undefined; `traceLink` is passed through verbatim (no validation beyond string).
- `TelescopeService` passes `traceContext` into the `new Recorder({...})` call
  (spread-guarded like `filter`).

### Meta endpoint (UI handshake)

`TelescopeMeta` gains `traceLink: string | null`. `getMeta()` returns
`this.config.traceLink ?? null`. The UI's existing meta fetch reads it once and
caches it; the entry-detail Trace row uses it to build the href.

## Storage changes

| Provider     | Change                                                                                     |
|--------------|--------------------------------------------------------------------------------------------|
| in-memory    | None — stores the `Entry` object as-is. New fields ride along.                              |
| redis        | None — `JSON.stringify(entry)` / `JSON.parse`. New string fields round-trip for free.       |
| sqlite       | Add `trace_id text`, `span_id text` to the `create table` DDL; add to `toRow`/`fromRow`/insert. PLUS a boot guard that runs `alter table … add column` if an existing table predates the fields (idempotent, swallow "duplicate column"). |
| mikro-orm    | Add `traceId`/`spanId` to `TelescopeEntry` (`type: 'string'`, nullable). Self-heal `schema.update({ safe: true })` adds the columns at boot automatically — no migration. |

All four keep newest-first pagination, filtering, batching unchanged — the new
fields are payload only, never part of the keyset or any WHERE clause.

## New package — `@dudousxd/nestjs-telescope-otel`

Mirrors the `@dudousxd` adapter conventions (see `[[reference-dudousxd-lib-conventions]]`).

- **Dependency:** `@opentelemetry/api` as a **peer dependency** (optional — host
  already has it if they use OTel) + devDependency for tests. No `@aws-sdk`-style
  heavy SDK; `@opentelemetry/api` is tiny and API-only.
- **Export:** `OtelTraceContextProvider implements TraceContextProvider`.
  ```ts
  current(): TraceContext | null {
    try {
      const span = trace.getActiveSpan();
      if (!span) return null;
      const ctx = span.spanContext();
      // isSpanContextValid guards the all-zero invalid context.
      if (!ctx || !isSpanContextValid(ctx)) return null;
      return { traceId: ctx.traceId, spanId: ctx.spanId };
    } catch {
      return null;
    }
  }
  ```
  Imports `trace`, `isSpanContextValid` from `@opentelemetry/api`. The whole body
  is try/catch-wrapped so a missing/broken tracer degrades to "no trace".
- **Wiring (README):**
  ```ts
  TelescopeModule.forRoot({
    traceContext: new OtelTraceContextProvider(),
    traceLink: 'https://grafana/explore?traceId={traceId}',
    // …
  });
  ```
- Tests use a fake span via `@opentelemetry/api`'s context API (or a stub tracer)
  — assert valid span → ids returned; no span → null; invalid context → null;
  throwing tracer → null.

## UI

`entry-detail.tsx` gains a **Trace** row, shown only when `entry.traceId` is
present:

- `traceId` (monospace) + `spanId` (monospace, smaller/secondary).
- If meta `traceLink` is set: render the `traceId`/`spanId` as an external link
  (`{traceId}`/`{spanId}` substituted, `target="_blank" rel="noreferrer"`).
- Else: plain text with a copy-to-clipboard affordance consistent with the
  existing detail rows.
- No new route, no new page. Pure additive row in the existing detail view.

## Testing strategy

- **core:** Recorder stamps ids when `traceContext.current()` returns a context;
  stamps `null/null` when it returns null or no provider is configured; provider
  throwing → entry still recorded with null ids (covered by existing swallow).
  Entry factory default updated. resolve-config passes `traceLink` through.
- **storages:** sqlite round-trips trace_id/span_id (incl. null) + the
  add-column boot guard on a pre-existing column-less table; mikro-orm
  integration round-trips + self-heal adds the two columns (additive guard);
  redis/in-memory round-trip (cheap assertions).
- **otel package:** the four provider cases above.
- **ui:** entry-detail renders the Trace row with a link when `traceLink` set,
  plain text when not, and omits the row entirely when `traceId` is null.

## Out of scope (future `-otel` phases)

- Exporting Telescope entries as OTel spans.
- Ingesting external spans as Telescope entries.
- Indexing/searching entries by traceId (filter UI). Storage stays payload-only
  for now; a `traceId` filter is an easy follow-up once the field exists.
- Auto-registering the provider from an installed OTel SDK (host wires it
  explicitly for now).

## Rollout / dogfood

After lib build is green: repack `core` + affected storages + `ui` + new `otel`
tarballs (cache-bust filenames — pnpm v11), wire flip's `telescopeOptionsFactory`
with `new OtelTraceContextProvider()` + a `traceLink`, reboot, confirm entries
carry trace ids when flip has an active span. **No npm publish / git push without
Davi's explicit OK.**
