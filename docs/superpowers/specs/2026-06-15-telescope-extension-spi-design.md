# Telescope Extension SPI + declarative dashboard panels

**Date:** 2026-06-15
**Status:** Design — approved, pre-plan
**Primary repo:** `nestjs-telescope` (the SPI lives in `core` + `ui`); first consumer ships in `nestjs-durable/packages/telescope`.

## Problem

Other libraries (starting with `nestjs-durable`) want to surface their own
health/metrics dashboards *inside* Telescope, so a developer maintaining the app
has one observability console instead of jumping between tools. Today that is not
possible:

- The Telescope UI is a **fixed, pre-built React bundle**. Navigable types live in
  a hard-coded `ENTRY_TYPES` array (`packages/ui/src/react/components/entry-types.ts`)
  and bespoke pages (Queues, Pulse, Overview) are compiled in. There is **no
  extension point** for an external package to contribute a tab or page.
- `nestjs-durable` already ships `packages/telescope` with a `DurableTelescopeWatcher`
  that turns engine events into Telescope entries + trace grouping — but that only
  produces an undifferentiated entry stream. There is no native "Workflows" view,
  and `durable` is not even in `ENTRY_TYPES`, so its entries render as an unknown type.

We want a **general extension mechanism** mirroring the model already proven in
`@dudousxd/nestjs-codegen` (`packages/core/src/extension/`): a versioned contract,
multi hooks that accumulate + single-slot hooks reserved for the future, an
`ExtensionContext`, a neutral IR that a fixed renderer interprets, and a
`defineExtension()` authoring helper. `nestjs-durable` is the **first consumer** and
the proof the mechanism works; the SPI is designed to its real needs and not
over-generalized.

## Goals

- A `TelescopeExtension` SPI in `nestjs-telescope` core, registered via
  `TelescopeModule.forRoot({ extensions: [...] })`, fully backward compatible with
  the existing `watchers: [...]` option.
- A **declarative dashboard panel IR** that an extension emits as data (no React),
  rendered natively by a generic renderer in `nestjs-telescope-ui`.
- **Dynamic navigation**: entry types and dashboards contributed by extensions appear
  in the UI nav, removing the hard-coded-only `ENTRY_TYPES` constraint.
- `nestjs-durable` ships a "Workflows" dashboard (health/metrics) as the first
  extension, reusing its existing watcher, with per-run drill-down deep-linking out to
  the durable dashboard for actions and the workflow graph.
- **User-facing documentation** in both projects' Fumadocs sites
  (`website/content/docs/`): the extension SPI + an authoring guide in `nestjs-telescope`,
  and the extension-based Workflows dashboard in `nestjs-durable`.

## Non-goals

- **Management/actions inside Telescope.** Retry/cancel/bulk and the `WorkflowGraph`
  / `SpansTimeline` stay in the durable dashboard. Telescope is *visibility*; it
  deep-links out for action. (Decision: goal "A — visibility" over "Manage+Metrics".)
- **Arbitrary remote React UI** (runtime module federation / iframes). Rejected:
  shared-singleton version coupling, build burden on backend libs, third-party asset
  serving + CSP exposure against Telescope's "safe in production" stance, and Tailwind
  purge defeating the native look. The declarative IR avoids all of these.
- **Single-slot extension hooks.** The pattern is documented and the registry is
  shaped to allow them, but no single-slot hook ships until a real consumer needs one.
- **A second consumer.** Vocabulary is scoped to what `nestjs-durable` needs; cache /
  authkit / codegen extensions are explicitly out of scope for this iteration.

## Architecture

Three layers, mirroring codegen (contract in core + neutral IR + fixed renderer):

```
nestjs-telescope (core)            ← TelescopeExtension contract, registry, panel IR types,
                                      data-provider routing, /api/meta + /api/ext/* endpoints
        ↑ forRoot({ extensions: [...] })
nestjs-telescope-ui                ← generic panel renderer + dynamic nav from /api/meta
nestjs-durable/packages/telescope  ← durableTelescopeExtension(): the first consumer
```

The existing `Watcher` interface (`packages/core/src/nest/watcher.ts`: `type` +
`register(ctx)` + `shouldRecord?`) is **unchanged**. A watcher becomes *one hook* of
an extension; the extension is the umbrella bundling watcher + entry type + dashboard +
data providers.

## The `TelescopeExtension` contract

Mirrors `CodegenExtension`: a `name` used for conflict/ordering, multi hooks that
accumulate, and an `ExtensionContext`. All hooks are optional.

```ts
interface TelescopeExtension {
  /** Unique id — used in conflict/collision errors and for deterministic ordering. */
  name: string;

  // ── multi hooks (every extension runs; results accumulate) ──
  /** Contribute watchers. Merged into the existing forRoot `watchers` list. */
  watchers?(ctx: ExtensionContext): Watcher[];
  /** Contribute navigable entry types — makes the hard-coded ENTRY_TYPES dynamic. */
  entryTypes?(ctx: ExtensionContext): EntryTypeDef[];
  /** Contribute declarative dashboard pages (the panel IR). */
  dashboards?(ctx: ExtensionContext): DashboardSpec[];
  /** Named server-side queries that panels bind to via { provider, query }. */
  dataProviders?(ctx: ExtensionContext): DataProvider[];
}

/** Identity helper for authoring with full type inference (mirrors defineExtension). */
export function defineTelescopeExtension(ext: TelescopeExtension): TelescopeExtension {
  return ext;
}
```

`ExtensionContext` is read-only and resolved at module init — at minimum
`{ moduleRef, config }` (matching what `WatcherContext` already exposes), so a data
provider can resolve host services (e.g. the durable `WorkflowEngine` / store).

A `DataProvider` is a named server-side query the panels bind to:

```ts
interface DataProvider {
  /** Stable name referenced by a panel's DataBinding, e.g. 'durable.timeseries'. */
  name: string;
  /** Resolve the data for a panel query. `query` is the panel's DataBinding.query.
   *  Return value shape is per-panel-kind (a number for stat, rows for table, etc.). */
  resolve(query: Record<string, unknown> | undefined, ctx: ExtensionContext): Promise<unknown>;
}
```

**Registration & conflicts.** `forRoot({ extensions: [...] })`. The registry:
- merges `watchers()` output into the existing watcher list (backward compatible);
- collects `entryTypes()` into the meta payload — a duplicate `id` across extensions
  (or colliding with a built-in id) is a hard error naming both, mirroring codegen's
  collision rule;
- collects `dashboards()` and `dataProviders()`; a duplicate `DashboardSpec.id` or a
  duplicate `provider` name is a hard error.

## The panel IR

A `DashboardSpec` describes a page; each `Panel` is a neutral node the UI renders by
reusing existing Pulse/Overview chart components. No React crosses the boundary.

```ts
interface DashboardSpec {
  id: string;          // stable route id, e.g. 'durable.workflows'
  label: string;       // nav label, e.g. 'Workflows'
  navGroup?: string;   // optional nav grouping
  panels: Panel[];
}

type Panel =
  | { kind: 'stat';       title: string; data: DataBinding; format?: 'number' | 'percent' | 'duration'; delta?: boolean }
  | { kind: 'timeseries'; title: string; data: DataBinding; series: string[]; style?: 'area' | 'line' }
  | { kind: 'topN';       title: string; data: DataBinding; limit?: number }
  | { kind: 'table';      title: string; data: DataBinding; columns: Column[] };

interface DataBinding { provider: string; query?: Record<string, unknown> }
interface Column { key: string; label: string; link?: LinkSpec } // link → deep-link out (durable dashboard / telescope trace)
```

Widgets that the vocabulary can't express (e.g. the durable `WorkflowGraph`) are **not**
modeled — they remain deep-links. The vocabulary is intentionally the minimum that
covers durable's metrics page; new widget kinds are added when a consumer needs them.

## Data flow (sources A + C)

1. UI fetches `/telescope/api/meta` → built-in nav **plus** extension `entryTypes` and
   `dashboards`. Nav renders dynamically (no longer hard-coded-only).
2. User opens "Workflows" → UI fetches the `DashboardSpec` and renders panels via the
   generic renderer.
3. Each panel calls `/telescope/api/ext/:ext/data/:provider?query=...` → core routes to
   the named `DataProvider` → returns data. Two source patterns:
   - **(A) captured entries** — time-series & rollups (throughput, success rate, top
     failures) read from Telescope's own stored `durable` entries, the same way Pulse
     rolls up. Bounded by the prune window; survives restart; gives history.
   - **(C) durable store** — current-state gauges (dead / running / suspended / pending
     *now*) read from the durable store via `listRuns`, which is the source of truth and
     must not depend on the prune window.
4. All endpoints sit behind the existing `authorizer` (single gate, default-deny in
   production). No new auth surface.

## First consumer: `nestjs-durable`

`nestjs-durable/packages/telescope` exports `durableTelescopeExtension()`:

- `entryTypes` → `{ id: 'durable', label: 'Workflows', dot: 'bg-…' }`.
- `watchers` → the existing `DurableTelescopeWatcher` (reused as-is, not rewritten).
- `dashboards` → a `durable.workflows` page with panels:
  - `stat` success rate, `stat` total runs, `stat` dead-now, `stat` suspended-now;
  - `timeseries` throughput (success vs failed over time);
  - `topN` workflows by failure count; `topN` slowest workflows;
  - `table` recent failed runs, each row deep-linking to the durable dashboard (graph /
    timeline / actions) and/or the Telescope trace for that run.
- `dataProviders`:
  - `durable.timeseries` — reads captured `durable` entries (source A);
  - `durable.state` — reads the durable store via `listRuns` (source C). Resolves the
    engine/store from `ctx.moduleRef`.

Actions (retry/cancel) and the graph stay in the durable dashboard, reached via the
table's deep-links.

## Component boundaries

- **`core/extension/types.ts`** — `TelescopeExtension`, `ExtensionContext`,
  `DashboardSpec`, `Panel`, `DataBinding`, `defineTelescopeExtension`. The published,
  versioned contract (semver 0.x).
- **`core/extension/registry.ts`** — resolves `forRoot.extensions`: merges watchers,
  collects entry types / dashboards / providers, enforces collision errors.
- **`core` controller** — new `GET /api/ext/:ext/data/:provider` route + extended
  `/api/meta` payload (entry types + dashboards). Behind the existing guard.
- **`ui` generic renderer** — interprets a `DashboardSpec` into Pulse/Overview chart
  components; a generic "extension dashboard" page/route; dynamic nav from `/api/meta`.
- **`nestjs-durable/packages/telescope`** — `durableTelescopeExtension()` wrapping the
  existing watcher + the new spec/providers.

## Documentation (deliverable)

Both projects use Fumadocs (Next.js, `website/content/docs/*.mdx`, nav via `meta.json`).

**`nestjs-telescope`** (`website/content/docs/`):
- `concepts/extensions.mdx` *(new)* — the extension model: `TelescopeExtension`, multi
  hooks, the panel IR + how the fixed UI renders it, dynamic nav, the data-provider
  flow, and how it relates to watchers. Mirrors the depth of `concepts/capture.mdx`.
- `recipes/building-an-extension.mdx` *(new)* — end-to-end authoring guide using
  `defineTelescopeExtension`, sibling to the existing `recipes/custom-watcher.mdx`.
- `reference/configuration.mdx` *(update)* — document the `extensions: [...]` `forRoot`
  option.
- `packages/index.mdx` *(update)* — note the SPI / link the new concept page.
- nav `meta.json` *(update)* — register the new pages.

**`nestjs-durable`** (`website/content/docs/observability/`):
- `telescope.mdx` *(update)* — currently documents the `DurableTelescopeWatcher`; extend
  it to cover `durableTelescopeExtension()`, the native "Workflows" dashboard (panels,
  metrics, current-state gauges), and the deep-link relationship to the durable
  dashboard for actions/graph. Cross-link to the Telescope extensions concept page.

Docs are written **alongside** the implementation (not after), so each phase that lands
a capability updates the relevant page in the same change.

## Error handling

- Extension registration collisions (duplicate entry-type id, dashboard id, provider
  name) → hard error at module init naming both extensions (fail fast, like codegen).
- A `DataProvider` that throws → the endpoint returns an error payload; the panel
  renders an inline error state (one bad panel never blanks the page).
- Missing host dependency (e.g. durable engine not registered) → the provider surfaces
  a clear "durable not available" message rather than a 500.
- Unknown `provider`/`ext` in the data route → 404 behind the gate.

## Testing

- **core registry**: watcher merge is additive; collision errors fire with both names;
  meta payload includes contributed entry types + dashboards.
- **core data route**: routes to the named provider, passes `query`, honors the gate,
  handles provider throw / unknown provider.
- **ui renderer**: each panel kind renders from a fixture spec; one provider error
  renders an inline error without breaking siblings; nav reflects `/api/meta`.
- **durable extension**: `durable.state` reads store gauges; `durable.timeseries` rolls
  up captured entries; deep-links resolve to the right run.

## Open questions (resolved during design)

- Data source → **A + C** (captured entries for series/rollups, store for current-state
  gauges). The in-memory `MetricsCollector` is intentionally left out to avoid a third
  source of truth.
- UI mechanism → **declarative IR (A)**, not federation/iframe.
- Page scope → **metrics/visibility only**; deep-link out for management.
- Generalization → **mirror durable's needs only**; no second consumer this iteration.
