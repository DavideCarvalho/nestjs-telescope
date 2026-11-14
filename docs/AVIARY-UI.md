# Aviary console UI

Four consoles ship in four separate repos and share one UI kit:

| console | repo | mount | accent |
|---|---|---|---|
| agent governance | `nestjs-agent/packages/dashboard` | `/ai-gateway` | violet `#a78bfa` |
| durable workflows | `nestjs-durable/packages/dashboard` | `/durable` | lime `#a3e635` |
| media | `nestjs-media/packages/dashboard` | `/media` | cyan `#22d3ee` |
| telescope | `nestjs-telescope/packages/ui` | `/telescope` | magenta `#e879f9` |

This file is copied verbatim into all four repos at `docs/AVIARY-UI.md`. Check the copies agree:

```sh
md5sum ~/personal/oss/nestjs/AVIARY-UI.md \
  ~/personal/oss/nestjs/{nestjs-agent,nestjs-durable,nestjs-media,nestjs-telescope}/docs/AVIARY-UI.md
```

## The kit

Every console renders through the **Aviary console kit**: one shell (sidebar with the console
switcher, nav sections, signed-in user, theme toggle and sign-out; topbar with the page title,
pickers and ⌘K), vendored shadcn primitives on Base UI, and blocks built from them (MetricCard,
Panel, DataTable, Pager, QueryBoundary, ErrorBoundary, EmptyState, ActionDialog).

- Canonical copy: `~/personal/oss/nestjs/_shared/console-kit/aviary-kit/`. Each console keeps a
  **verbatim** copy at `<dashboard pkg>/src/aviary-kit/`.
- Full rules — files, build settings, dependencies, token classes, props, the server data-block
  contract — are in `~/personal/oss/nestjs/_shared/console-kit/README.md`. Read it before touching a
  console's UI.
- Reference implementation: the durable console (`nestjs-durable/packages/dashboard`).
- Screenshots: `~/personal/oss/nestjs/_shared/console-kit/screens/<console>/`.

## Rules

1. **One kit, copied verbatim.** Never edit `aviary-kit/` in one console only. Change the canonical
   copy, then copy it into all four consoles in the same session. A console that needs a generic fix
   changes its copy minimally and reports the exact diff so it can be merged back.
2. **One accent per console, everything else shared.** The accent is the console's only colour
   input (`ThemeProvider accent`); the kit derives the soft fill, hover, border, focus ring, glow and
   the light-mode ink (WCAG AA on white). `CONSOLE_ACCENTS` in `icons.tsx` holds the four above.
3. **Tokens, not palette classes.** Use the kit's token classes (`text-fg`, `text-dim`,
   `text-faint`, `bg-card`, `bg-hover`, `border-border`, `text-bad`, `bg-warn/10`, `text-brand`,
   `bg-primary`, …), never raw `zinc-*`/`rose-*` classes or hex colours: those break light mode.
   Inline colours use `var(--aviary-*)`. Status hues (run, upload, entry states) are console CSS
   built on `var(--aviary-*)` with light-mode overrides.
4. **Light and dark.** Both themes work on every page. The theme is stored per console in
   localStorage (`aviary-<console>-theme`).
5. **Fonts are bundled.** Sora for the UI, JetBrains Mono for data (`.mono`). No Google Fonts.
   Telescope's shell is not all-monospace.
6. **Container/presentational.** A `*Page` container owns the queries; a `*View` renders props.
   Every page and every independently fetching region sits in an ErrorBoundary. Loading shows
   skeletons shaped like the content; empty shows an EmptyState; failures show a RegionError with
   Retry. The access-denied page stays.
7. **Responsive.** Below 768px the sidebar is a drawer; list + detail workbenches stack.
8. **Names.** Tokens `--aviary-*`, classes `.aviary-*`, local edits to vendored files marked
   `aviary:`. Never the word "agora" in Aviary code.

## Sidebar sections

- durable: MONITOR (Runs, Workers) · OPERATIONS (Schedules)
- agent: MONITOR (Overview, Reliability) · ACTIVITY (Runs, Threads, Tool calls, …) · GOVERNANCE
  (Approvals, Quota) · CONFIG (Tools, Pricing)
- media: LIBRARY (Library, Collections) · TRANSFERS (Uploads, Disks)
- telescope: MONITOR (Overview, Pulse, Exceptions) · EXPLORE (Entries, Traces, …) · OPERATIONS
  (Queues, Schedules) · DASHBOARDS · WATCHERS · DATA (Exports)

## Server side (each lib)

The console's JSON config block carries, besides its own fields: `switcher` (other consoles),
`search` (⌘K endpoint; `self` = this console's id when the route answers `?console=<id>`),
`viewer` (from a `viewer(request)` option, else `request.user` read structurally) and `signOut`
(from a `signOut` option, else the registry's `account.signOut`; same-origin paths only). The
registry is `Symbol.for('@dudousxd/aviary:consoles')`; `GET <api>/consoles` and
`GET <api>/consoles/search` keep their contracts. Details in the kit README.
