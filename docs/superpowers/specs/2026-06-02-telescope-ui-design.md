# `@dudousxd/nestjs-telescope-ui` Design

**Status:** approved-in-conversation (2026-06-02). Brainstorm gate waived by Davi ("bora implementar"); design captured here for reference.

## Goal

A visual dashboard for `@dudousxd/nestjs-telescope` — a bundled React SPA served by a NestJS controller, consuming the existing headless API (`/telescope/api/*`). Zero frontend dependencies imposed on the host. Additionally, expose the SPA's building blocks (client, hooks, components) so consumers can compose their own dashboard.

## Key decisions

- **Bundled SPA, not host-coupled.** React + Vite + Tailwind are built into static assets **at publish time** (our devDependencies). The host serves pre-built HTML/JS/CSS via a Nest controller — it needs no React/Vite/Tailwind and works for any backend (even pure-API). This is the Laravel-Telescope/Horizon/Bull-Board pattern. (Inertia was rejected precisely because it couples to the host's frontend.)
- **Hash routing** (`/telescope#/entries`) — the server serves only the shell + assets; all navigation is client-side, so there is zero collision with `/telescope/api/*` and no server-side SPA fallback is needed.
- **Polling** (TanStack Query `refetchInterval`) for live updates. SSE live-tail is out of scope for v1.
- **Visual:** dark console aesthetic (dense, monospace-leaning), Tailwind, no logo/branding.
- **Layered + composable** (Davi's ask): the turnkey app is assembled from exported layers so users can build their own.

## Architecture / layers

```
src/client/   Framework-agnostic typed API client over /telescope/api.
              createTelescopeClient(opts) -> { entries(query), entry(id), pulse(window), queues(window), meta() }
              Pure TS (fetch). No React. Exported at "/client".
src/react/    TanStack Query hooks (options-returning, per Davi's convention):
              entriesQuery(client, q) -> queryOptions; useEntries(q); useEntry(id); usePulse(w); useQueues(w).
              + presentational components: <EntriesTable>, <EntryDetail>, <BatchTimeline>,
              <PulsePanel>, <QueuesPanel>, <TypeTabs>, <DashboardLayout>.
              Peer deps: react, react-dom, @tanstack/react-query. Exported at "/react".
src/app/      The bundled dashboard: main.tsx + App (hash router) + 3 pages assembled from src/react.
              A TelescopeClientProvider supplies the client (baseURL '/telescope/api') + QueryClient.
              Built by Vite -> dist/spa. NOT exported (it's the turnkey artifact).
src/server/   TelescopeUiModule + TelescopeUiController (serves dist/spa). Nest.
              Peer deps: @nestjs/common, @nestjs/core. Exported at "." (default).
```

### Exports map
- `.` → `dist/server/index.js` — `TelescopeUiModule` (backend serves the turnkey dashboard).
- `./react` → `dist/react/index.js` — components + hooks + client re-export.
- `./client` → `dist/client/index.js` — the typed client only (no React).

## Views (v1)

1. **Entries** — `#/entries`. Type tabs (All / request / query / job / exception / http_client / mail), a dense table (time, type, label/summary, duration, tags, status), polling refetch, keyset pagination (load-more / infinite scroll). Row → detail.
2. **Entry detail** — `#/entries/:id`. The entry's content (pretty-printed) + a **BatchTimeline**: all entries sharing its `batchId`, ordered by `sequence` — the correlation payoff (the request and everything it caused).
3. **Pulse** — `#/pulse`. Health snapshot from `/telescope/api/pulse`: per-type counts, slowest entries, top exceptions, N+1 occurrences. Tables (no charts in v1).
4. **Queues** — `#/queues`. Per-queue metrics from `/telescope/api/queues`: throughput, runtime/wait percentiles, failure rate. Tables.

A `DashboardLayout` shell provides the dark theme + nav between the four views + a window selector (1h/24h/…) for Pulse/Queues + a live/pause toggle for polling.

## Serving (the novel infra)

`TelescopeUiController` (platform-agnostic — no `express.static`/`@fastify/static`):
- `GET /telescope` → `index.html` (the shell), `Content-Type: text/html`.
- `GET /telescope/assets/:file` → the hashed Vite asset (js/css), correct `Content-Type`, **path-traversal-safe** (reject `..`/separators; serve only from the resolved `dist/spa/assets` dir).
- Assets dir resolved from the compiled module via `import.meta.url` (`dist/server` → `../spa`), overridable via `TelescopeUiModule.forRoot({ assetsDir })` for testability.
- Vite `base: '/telescope/'` so the built `index.html` references `/telescope/assets/*`.

Core change: extend the request middleware `exclude` from `telescope/api/{*splat}` to `telescope/{*splat}` so the dashboard's own shell/asset loads aren't recorded as request entries.

## Build

`pnpm build` runs: `vite build` (src/app → `dist/spa`) + `tsc -p tsconfig.server.json` (src/server → `dist/server`) + `tsc -p tsconfig.lib.json` (src/client + src/react → `dist/client`, `dist/react`). Ships `dist/` (incl. bundled `dist/spa`).

## Testing

- **Server (rigorous):** controller serves `index.html`; serves a known asset with the right content-type; rejects path traversal; honors `assetsDir` override. Use a fixture assets dir (no real Vite build needed in the unit test).
- **Client:** `createTelescopeClient` builds correct URLs/queries and parses responses (fetch mocked).
- **React:** smoke-render `<EntriesTable>` / `<PulsePanel>` with mocked hook data (render-without-crash + key fields shown). Light — not pixel TDD.

## Out of scope (v1, noted not stubbed)
SSE live-tail; charts/sparklines + time-series capture; in-app entry deletion/clear UI; theming/customization; auth UI (shell is open; API stays guarded). These are fast follow-ups.

## Risks
- Dual/triple build wiring (Vite + 2× tsc) and the `import.meta.url`→`dist/spa` resolution are the main infra risk; the controller's `assetsDir` override + fixture tests de-risk the serving path independently of the SPA build.
- Package size grows by the bundled assets (~100–300KB) — accepted, standard for embedded dashboards.
