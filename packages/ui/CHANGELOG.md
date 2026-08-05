# @dudousxd/nestjs-telescope-ui

## 1.22.1

### Patch Changes

- [#80](https://github.com/DavideCarvalho/nestjs-telescope/pull/80) [`1378075`](https://github.com/DavideCarvalho/nestjs-telescope/commit/137807549d64889222d9119534b8e8be4d5c7651) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop a provider that ignores `query.page` from freezing a paged table's pager.

  `PagerControls` read its current page off the **response**, and its handlers computed `page ± 1`
  from that. When a provider answers with a pinned page — as `@dudousxd/nestjs-agent-telescope`'s
  did, reading `?page=2` as a string and returning page 1 for every request — the result was not a
  stale number but a dead control: the first click moves the caller's state to 2 and refetches, the
  response still says 1, so the second click asks for 2 again, the state does not change, React skips
  the re-render, and neither button does anything again short of a page reload. Prev never re-enables.

  `PanelView` now takes an optional `requestedPage` — the page the caller has asked for — and prefers
  it over the response's. `ExtensionDashboardPage` passes its own paging state, so every click keeps
  advancing and the worst a broken provider can do is fail to change the rows: visible, and
  recoverable with Prev. Panels whose provider honours paging are unaffected, since the two values
  agree; a caller that passes no `requestedPage` still reads the page off the response exactly as
  before.

## 1.22.0

### Minor Changes

- [#78](https://github.com/DavideCarvalho/nestjs-telescope/pull/78) [`5832622`](https://github.com/DavideCarvalho/nestjs-telescope/commit/58326225e99fa134997d85e5e81952d7d505ad1c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Rebuild the chart cards on a vendored shadcn chart layer, and give them a legend, a brush and
  drill-down.

  Every chart in the console — the Overview throughput and by-type areas, the queues bars, the entry
  insights, and every chart-shaped extension panel — was hand-rolled Recharts: each card restated its
  own grid stroke, axis stroke, tick style and the three `contentStyle`/`labelStyle`/`itemStyle`
  objects that make up Recharts' single line of tooltip text. Series colours lived in two places, and
  chrome colours in seven.

  - **`src/react/ui/chart.tsx`** joins the vendored primitives: `ChartContainer`, `ChartTooltip`,
    `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent` and the `ChartConfig` type, retuned to
    the Aviary tokens. Two departures from upstream shadcn, both deliberate: chart chrome is styled by
    selecting Recharts' own class names off the container (a stylesheet rule beats an SVG presentation
    attribute), and the per-series `--color-<key>` custom properties are set inline instead of through
    shadcn's `dangerouslySetInnerHTML` style tag — a config that can come from an extension-authored
    dashboard spec should not reach an HTML-injection-shaped API.
  - **`chart-theme.ts` is now the only place a series colour is decided**, and the chrome constants it
    used to export are deprecated rather than removed. Breakdown segments resolve through the same
    entry-type hues as everything else, so an `exception` segment is no longer amber in a donut and red
    in the chart beside it.
  - **Rich hover cards** everywhere: label row, one row per series with its own swatch, configured name
    and formatted value. Everything read out of a Recharts payload goes through runtime guards — a
    provider can return anything, and a tooltip rendering `[object Object]` is a bug nobody notices
    until it is in a screenshot.
  - **Clickable legends** on the multi-series charts: an entry toggles its series, which restacks the
    rest. With six entry types stacked, switching the big ones off is the only way to read the small
    ones. The entries are the vendored `Button` with `aria-pressed`, not bare `<button>`s.
  - **Brush on the timeseries charts**, so a long window can be narrowed in place. It appears once a
    series passes 24 points and can be forced either way with `brush`; below that it is a scrollbar for
    a page that already fits.
  - **Drill-down.** A chart-shaped panel that declares `drilldown: { param }` becomes clickable: the
    click sets one dashboard-wide selection, every panel re-resolves with that param merged onto its
    own `data.query`, and a chip in the header says what is filtered (clicking the same item again, or
    the chip's Clear, undoes it). A panel that declares no `drilldown` gets no click handler at all, so
    every dashboard shipping today behaves exactly as before. The cards themselves take a typed
    `onSelect(selection)` and know nothing about dashboards; `BarChartCard.onBarClick` still fires and
    is deprecated in favour of it.
  - Two bugs the rewrite surfaced: a `gauge` panel drew a full half-dial whatever it was reporting
    (with one datum and no explicit polar domain, Recharts scales the arc to the value itself), and a
    `distribution` panel's percentile chips pushed its chart out of the card by exactly their own
    height.

- [#77](https://github.com/DavideCarvalho/nestjs-telescope/pull/77) [`b330bfc`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b330bfce9b025dc5bfe1c695eaaeeea80b007f82) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Rebuild the extension-dashboard `table` panel on TanStack Table v9, and give it server-side sort
  and filter.

  A table panel could only ever be read. Sorting it was not an oversight so much as an unanswered
  question: the panel holds the one page its provider returned, so a sort added in the browser would
  have ordered 50 rows out of 50,000 and presented the result as "the slowest runs" — a control that
  is wrong precisely when someone is relying on it. The answer here is that the choice goes back to
  the provider, which is the only party that can see the whole result set.

  **The new SPI** (additive; existing panels and providers are untouched). A column opts in:

  ```ts
  columns: [
    { key: "runId", label: "Run", filterable: true },
    { key: "duration", label: "Duration", sortable: true },
    { key: "worker", label: "Worker", hideable: true },
  ];
  ```

  - `sortable` — the header becomes a button cycling ascending → descending → unsorted, and the
    provider is re-resolved with `sort=<key>` + `dir=asc|desc` (both absent when unsorted).
  - `filterable` — a filter box appears under the header, committed on Enter or blur, sent as
    `filter.<key>=<text>`. Namespaced because a panel scoped to `{ status: 'running' }` carrying a
    filterable `status` column is an ordinary combination, and unprefixed one would silently
    overwrite the other.
  - `hideable` — the column joins the panel's **Columns** menu. Display-only; it never reaches the
    provider, and the menu is absent entirely when no column opts in.

  Providers read the state with the new `readTableQuery(query)` from `@dudousxd/nestjs-telescope`,
  which returns `{ page?, limit?, sort?: { key, dir }, filters }`. Reading it by hand is the trap it
  exists to close: every value arrives as a **string** off the URL, so `query.page > 1` is silently
  `false` for `'2'`, and `?page=banana` reaches a `LIMIT` clause as `NaN`. It also drops an emptied
  filter box (`filter.status=` means _no_ filter, not "match the empty string") and reads an
  unrecognized direction as ascending.

  Backward compatibility is the point, not a footnote: a provider that ignores the new params behaves
  exactly as before, and a panel whose columns declare none of the three flags renders the identical
  table — no header buttons, no filter row, no column menu, and the byte-identical query on the wire.
  The query builder returns the panel's own `data.query` _by identity_ when there is nothing to merge,
  so existing dashboards do not even move to a new React Query cache key.

  - **v9's explicit feature model.** `table-features.ts` is the package's only module that imports
    `@tanstack/react-table`; everything else consumes the hook, `flexRender` and the pre-bound types
    through it. v9 installs a feature's state and instance methods only when it is registered, and an
    unregistered feature is not an error — the method is simply gone, which at the call site is
    indistinguishable from "removed in v9". A contract spec asserts every API the table actually calls.
  - **No client row models are registered**, deliberately. `createSortedRowModel` and friends would
    re-do server-side work over the single page in hand, which is the exact failure this change exists
    to avoid. `rowPaginationFeature` and `columnSizingFeature` are left out too — the pager is driven
    by what the provider returned, and column sizing would default every column of every dashboard to
    a fixed 150px.
  - **A paged table's rows now scroll under a pinned header**, capped at 28rem. A 50-row page was
    otherwise a ~1,500px card that pushed every panel below it off screen, and by row 40 the column
    labels were long gone. A short page never reaches the cap and is unchanged.
  - The vendored `Table` primitive gains `containerClassName`. That wrapper div is already a scroll
    container, so it is the element a sticky header positions against — a `max-h-*` applied anywhere
    further out gives a scrolling ancestor the sticky cells cannot see.
  - `@tanstack/react-table` is declared as an optional peer dependency, alongside `recharts` and
    `@tanstack/react-query`: the bundled SPA carries its own copy, so only a host composing these
    React components itself needs to install it.

## 1.21.1

### Patch Changes

- [#75](https://github.com/DavideCarvalho/nestjs-telescope/pull/75) [`f5ba9bf`](https://github.com/DavideCarvalho/nestjs-telescope/commit/f5ba9bf29c16b55244cf05e41f12e31a202919cd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop an extension dashboard's tables from painting outside their cards.

  A `table` panel was the one surface in the console still rendering hand-rolled `<table>` markup:
  it never moved onto the vendored shadcn `Table` when that primitive landed, so it also never got
  the scroll container the primitive brings. That matters because a section lays its panels out as
  a `grid-cols-N` of equal cells, and a card is routinely narrower than the table inside it — a
  7-column table in a `cols: 3` section. `w-full` is only a _preferred_ width: `table-layout: auto`
  still lays the table out at its min-content width, and with nothing clipping it the remaining
  columns painted over the neighbouring panel.

  Measured on flip's `durable.workflows` dashboard: a 379px card holding a 633px "Worker health"
  table (its `STATUS` column landed on top of the panel to its right), and a 575px card holding a
  1154px "Workers" table. `agent.overview` had the same break — `COST (USD)` and `LAST ACTIVITY`
  rendered outside their cards.

  - Both table variants, paged and not, now render through `Table`/`TableHeader`/`TableBody`/
    `TableRow`/`TableHead`/`TableCell`, so a table too wide for its card scrolls inside it and
    every panel keeps the same row height, header casing and divider colour as the rest of the app.
  - Cells are `whitespace-nowrap`. Wrapping is what turned durable's "Workers" panel into
    three-line rows; with a scroller in place, a long worker id belongs on one line behind a
    scrollbar.
  - The pager's prev/next are the vendored `Button` (`outline`/`xs`) rather than bare `<button>`s.

## 1.21.0

### Minor Changes

- [#73](https://github.com/DavideCarvalho/nestjs-telescope/pull/73) [`5203512`](https://github.com/DavideCarvalho/nestjs-telescope/commit/520351225a9f0f754e11cc7ef3e28a17d4499d11) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Adopt the Aviary console design tokens and a vendored shadcn-on-Base-UI primitive layer.

  The dashboard was authored against hardcoded Tailwind `zinc`/`emerald` utilities — the only
  Aviary console with no token vocabulary at all. It now declares the canonical tokens from
  `AVIARY-UI.md` (`--bg`, `--panel`, `--panel-2`, `--line`, `--line-soft`, `--text`, `--muted`,
  `--good`, `--warn`, `--bad`, `--live`, `--accent`) and consumes them through Tailwind semantic
  colours, so it reads as a sibling of the agent, durable and media consoles rather than a stranger.

  - **Light mode actually works.** It was a block of `.light .bg-zinc-900 { … }` overrides that
    covered only the utilities someone had remembered to list, leaving mid-grey panels and
    unreadable status text. The tokens are now declared twice — dark under `:root`, light under
    `.light` — so every token-based surface, border, label and status flips with the theme.
  - **Telescope's accent is magenta** (`#e879f9`). Its de-facto accent was emerald-400, which is
    byte-identical to `--good`: the same hue meant both "healthy" and "interactive", side by side
    on the Overview page. Magenta clears `--good`, `--warn`, `--bad`, `--live`, agent's violet and
    media's cyan.
  - **Vendored shadcn primitives** under `src/react/ui/` on Base UI — `Button`, `Badge`, `Input`,
    `Table`, `Select`, `Tabs`, `Tooltip`, `Dialog` — wired so shadcn's semantic classes resolve to
    the Aviary tokens. Note that shadcn's `accent` is a _hover surface_, so the brand hue is
    exposed as `brand`/`--accent` and never as `bg-accent`.
  - The command palette and the queue job drawer are now one `Dialog` implementation instead of
    two hand-rolled overlays, and the two native `<select>` popups (which the OS drew, unthemed)
    are now themable listboxes.

  `cacheBadge()` and `inertiaBadges()` gain a `variant` field naming the semantic `Badge` variant.
  `className` is unchanged in shape and still returned, so existing callers keep working; prefer
  `variant` in new code.

  Also fixes a long-standing packaging bug this work's bundle check surfaced: the `./react` barrel
  reaches `recharts`, `react-router-dom` and `reflect-metadata`, none of which this package declared
  — the exact failure that once broke a host's client build. They are now declared as optional peer
  dependencies. `@base-ui-components/react`, `class-variance-authority`, `clsx` and `tailwind-merge`
  are `dependencies`, because this package publishes React source that hosts bundle. A new
  `published-graph.spec.ts` bundles each published entry with esbuild and asserts every package it
  reaches is declared, so this cannot regress silently.

### Patch Changes

- [#71](https://github.com/DavideCarvalho/nestjs-telescope/pull/71) [`68e4052`](https://github.com/DavideCarvalho/nestjs-telescope/commit/68e40523200c699dae3a376752b8604d3d68ef1f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Bound the React peer ranges to the majors this package is actually built and tested against.

  `react` and `react-dom` were declared `>=18.0.0` and `@tanstack/react-query` `>=5.0.0` — open-ended
  ranges that claim support for every future major. React 20 and Query 6 do not exist yet and
  certainly are not tested here, so the declaration was a promise the package cannot keep; a consumer
  on a future major would get no warning and a runtime surprise instead.

  Now `^18.0.0 || ^19.0.0` and `^5.0.0`. Both majors are real: the package builds and tests against
  React 18, and its `./react/console` launcher is consumed from a React 19 host.

  No behaviour change — peer ranges only affect what a package manager warns about on install.

## 1.20.1

### Patch Changes

- [#69](https://github.com/DavideCarvalho/nestjs-telescope/pull/69) [`acdfacb`](https://github.com/DavideCarvalho/nestjs-telescope/commit/acdfacba22495b6517bf89d7e50a25d3032c1933) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Clear the console launcher's pending state when the page is restored from the back/forward cache.

  `useOpenTelescopeConsole` deliberately keeps `isPending` set after a successful mint so the button
  does not flicker back to idle on a page that is navigating away. With bfcache the page does not die:
  pressing Back restored the launcher with its React state intact, leaving a permanent "Opening…"
  spinner on a button that could never be clicked again. The hook now listens for `pageshow` and
  resets only when `event.persisted` is true, so a fresh load and a mint that is still genuinely in
  flight both keep the original behaviour.

## 1.20.0

### Minor Changes

- [#67](https://github.com/DavideCarvalho/nestjs-telescope/pull/67) [`87c8732`](https://github.com/DavideCarvalho/nestjs-telescope/commit/87c8732006a46eeea50d1dd1536c8a9794a13ae5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship the console launcher on its own subpath: `@dudousxd/nestjs-telescope-ui/react/console`.

  The launcher was only reachable from the `./react` barrel, which re-exports the whole dashboard
  component set and therefore pulls in `recharts` and `react-router-dom`. Neither is declared by this
  package, and a bundler resolves re-exported modules even when nothing references them — so a host
  that wanted nothing but the launcher button got a hard build failure on a missing dependency
  instead of tree-shaking it away.

  `./react/console` re-exports the hook, the button and the headless client primitives, and nothing
  else. Its entire dependency footprint is `react`, guarded by a test that walks the import graph.

  `./react` is unchanged and still exports the launcher, so nothing breaks.

## 1.19.0

### Minor Changes

- [#65](https://github.com/DavideCarvalho/nestjs-telescope/pull/65) [`be97836`](https://github.com/DavideCarvalho/nestjs-telescope/commit/be978365f716cbe9e120b4024abb5d0ff6129d3d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **React tier for the console launcher: `useOpenTelescopeConsole` and `<OpenTelescopeConsoleButton>`, exported from `@dudousxd/nestjs-telescope-ui/react`.**

  The headless `openTelescopeConsole` gave hosts the mint-then-navigate call; every host then wrote the
  same three lines of React around it — an `isPending` flag, an error slot, and a button that has to
  remember not to fire twice. Three tiers now, pick the one that fits and drop a level when it stops
  fitting:

  ```tsx
  import {
    OpenTelescopeConsoleButton,
    useOpenTelescopeConsole,
    openTelescopeConsoleMutationOptions,
  } from "@dudousxd/nestjs-telescope-ui/react";

  // 1. drop-in
  <OpenTelescopeConsoleButton
    className="btn btn-primary"
    headers={authHeaders}
  />;

  // 2. state only, your markup
  const { open, isPending, error, reset } = useOpenTelescopeConsole({
    headers: authHeaders,
  });

  // 3. openTelescopeConsole(...) from `/client` — no React at all
  ```

  - `open()` **never rejects**; the refusal lands in `error` as a `ConsoleSessionError` (with its
    `status` and `url`). It deliberately does not clear `isPending` on success, because the navigation
    is already underway and flipping back to idle flickers "ready to click again" on a page that is
    leaving.
  - `<OpenTelescopeConsoleButton>` is **unstyled on purpose** — a bare `<button>` that forwards
    `className`/`style`/every other button prop, so it inherits the host's design system instead of
    importing CSS that fights it. It renders inside the host app, not inside Telescope's own bundle.
    It disables itself and sets `aria-busy` while in flight, and renders the refusal as
    `<p role="alert">` by default: a launcher that silently does nothing reads as broken rather than
    forbidden. `renderError` substitutes that node; `renderError={null}` opts out entirely.
  - `openTelescopeConsoleMutationOptions()` returns the `{ mutationKey, mutationFn }` shape
    `useMutation` takes, so a host already on TanStack Query gets the launcher in its cache, devtools
    and error handling with no adapter — and this package still never imports `@tanstack/react-query`.

  React stays an optional peer dependency: a host that only mounts the NestJS module pulls none of
  this in. Additive only; nothing existing changes.

## 1.18.0

### Minor Changes

- [#63](https://github.com/DavideCarvalho/nestjs-telescope/pull/63) [`2d0e76e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/2d0e76ee52e3a556c24b567fdb4b9e6cef25c067) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Headless console launcher: `openTelescopeConsole` / `mintTelescopeConsoleSession` / `telescopeConsoleSessionUrl`, exported from `@dudousxd/nestjs-telescope-ui/client`.**

  The console is entered from the HOST's app: a browser navigation to it carries no identity, so
  something inside the host has to mint the Mode A session cookie first (an XHR that _does_ carry the
  host's auth), then navigate. Every host was writing that by hand, which meant hardcoding two things
  this package owns:

  - **the session endpoint's path** — `<path>/api/auth/session`. Nothing tells a host when that moves; the break
    only shows up as a runtime 404 after a version bump.
  - **`redirect: 'manual'`** — and this one is a real trap. `fetch` follows redirects by default, so a
    host whose auth layer rewrites a 401 into a sign-in redirect gets a resolved 200 against the
    sign-in HTML. `response.ok` reads true, the caller navigates, and the user lands in a console with
    no session — indistinguishable from a permissions bug. The helper detects the redirect (browser
    opaque response _and_ Node/undici 3xx) and throws a message naming the likely cause.

  ```ts
  import { openTelescopeConsole } from "@dudousxd/nestjs-telescope-ui/client";

  await openTelescopeConsole({
    headers: () => ({ Authorization: `Bearer ${token()}` }),
  });
  ```

  No UI: the host owns the button, the page and the copy. `headers` accepts a sync or async function
  so a refreshing token is read at call time rather than captured at wiring time. `fetch` and
  `navigate` are injectable (tests, routers, non-browser callers). A refused mint throws
  `ConsoleSessionError` (carrying `status` and `url`) and **does not navigate** — a denied user gets a
  real error instead of the console's "no session" page.

  Additive only: nothing existing changes.

## 1.17.0

### Minor Changes

- [#61](https://github.com/DavideCarvalho/nestjs-telescope/pull/61) [`c3ee743`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c3ee743fd7c51b34dcc2b349d07659ce9d5d7cbe) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **`dashboardAuth.unauthenticatedPage` — hosts can now render the dashboard's unauthenticated page themselves.**

  Under Mode A, a visitor navigating straight to `/telescope` with no cookie got the SPA shell, which
  then rendered the built-in auth screen: _"open this console from your application."_ Deliberately
  generic, because the library cannot know who hosts it — it can't name the host's launcher, link to
  it, or look like the rest of the host's product.

  ```ts
  const dashboardAuth = {
    secret: process.env.TELESCOPE_AUTH_SECRET,
    session: (request) => resolveAdmin(request),
    unauthenticatedPage: ({ request, response, basePath }) => {
      (response as Response)
        .status(401)
        .render("console-locked", { returnTo: basePath });
    },
  };

  TelescopeModule.forRoot({ enabled: true, dashboardAuth });
  TelescopeUiModule.forRoot({ dashboardAuth }); // <- also here; see below
  ```

  Telescope's auth screen is a React component inside the published bundle — there is no
  server-rendered page to replace. So the hook gates the **SPA shell route**: the session is checked
  before the shell is served, which also means the bundle no longer loads at all for a visitor with no
  session. Hashed assets stay ungated; they carry no data.

  **`TelescopeUiModule` gains a `dashboardAuth` option, and it must be given the same config.**
  `TelescopeModule` (core) gates the JSON API; `TelescopeUiModule` serves the HTML, so it is the only
  one that can replace that page — the same independence the two modules' `guards` options already
  have. Setting `unauthenticatedPage` on core alone changes nothing a visitor sees. Only `secret`, the
  configured modes and `unauthenticatedPage` are read there; minting and renewal stay core's job.

  **Mode-A-only by design.** With `login` configured the hook is ignored: under Mode B the login form
  the visitor needs is _inside_ the bundle this page would replace, so gating the shell would lock a
  Mode B host out of its own dashboard.

  Fail-closed by construction: it only runs when the request carries no valid session cookie (a cookie
  signed with another secret does not count), and every data route stays behind `TelescopeGuard`
  regardless. A hook that throws, or returns without writing, logs one warning and serves the SPA
  rather than hanging the request or turning a navigation into a `500`.

  The UI shell route became non-passthrough `@Res()` so the host can own the response; its
  `Content-Type`/`Cache-Control` moved from decorators into a new `sendHtml` helper, unchanged. Core
  additionally exports `sendHtml` / `responseAlreadyWritten`.

  Fully backward compatible — omit the option and the shell is served exactly as before, with no
  session check on that route at all.

## 1.16.1

### Patch Changes

- [`c07d42a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c07d42a756e77b54ec92db4249ec060d9556e21c) - Docs + regression tests confirming `dashboardAuth`'s `login` hook already receives the submitted password verbatim end-to-end — including an empty string, since the built-in login screen never marks the field `required` and the auth controller only checks it's a string, not a non-empty one. No code path was blocking empty passwords; this closes the gap for hosts whose `login` hook gates on username alone (e.g. email must be an active admin) and deliberately ignores the password. Documented the pass-through in the `dashboardAuth` reference and added tests asserting: the hook is called with `''`, a hook rejecting an empty password still uniform-fails with `401`, and a hook accepting one mints the session.

## 1.16.0

### Minor Changes

- [`46f6bd4`](https://github.com/DavideCarvalho/nestjs-telescope/commit/46f6bd491c962f694ed41066f47da4da29671c3f) - First-class `guards` (+ `imports`) options for the Telescope console, mirroring `@dudousxd/nestjs-agent`'s dashboard module: `TelescopeModule.forRoot`/`forRootAsync` and `TelescopeUiModule.forRoot`/`forRootAsync` now accept `guards: Array<Type<CanActivate> | CanActivate>` fronting the console's controllers, plus `imports` resolving a class guard's own dependencies.

  This closes the auth seam for hosts with header-only auth: a full-page navigation to the dashboard carries no `Authorization` header, so there was previously no way to hang a cookie/session guard on the page itself. Pass the SAME `guards` (and `imports`) to both modules — they're independent options in separate packages. On core, `guards` **appends** to (never replaces) the existing `TelescopeGuard` gate (`authorizer` / `dashboardAuth` / dev-open-prod-closed default); on `-ui`, `TelescopeUiController` had no guard of its own, so it's a plain replace. See the new "Securing the console with your own guards" docs section.

## 1.15.0

### Minor Changes

- [`dbaf8d2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/dbaf8d2c00c08bc03c8df874cabc0c48741d712f) - Ext-dashboard tables paginate: a table panel may declare `paged: true` — the renderer adds
  prev/next + "Page X of Y" and re-resolves the provider with `query.page`/`query.limit`, expecting
  `{ rows, total, page, limit }`. Non-paged tables are byte-identical. `LinkSpec` documents the two
  href conventions (in-app hash routes — including the trace view at `#/traces/{traceId}` — vs host
  console paths); hash hrefs already navigate in-app.

## 1.14.0

### Minor Changes

- [#33](https://github.com/DavideCarvalho/nestjs-telescope/pull/33) [`996c9d4`](https://github.com/DavideCarvalho/nestjs-telescope/commit/996c9d442eb16f581acf67aca9ead84ce3bbc6c1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make cache observability cache-agnostic and richer. `CacheContent` keeps its
  universal core (`operation`/`key`/`hit`) and gains optional, vendor-neutral
  dimensions any cache can map onto: `store`, `tier` (e.g. l1/l2), `stale`
  (stale-while-revalidate / BentoCache grace), `ttlMs`, and a `metadata` escape
  hatch. `operation` widens to include `delete`/`clear`. The cache watcher's
  `{ instrument }` event carries these through (and surfaces store/tier/stale as
  tags), and the auto-patch path now records the set TTL and wraps `del`/`delete`
  so deletes are their own operation instead of being invisible or mislabelled.
  The stats endpoint splits hits/misses by tier and counts stale hits + deletes,
  and the Cache insights view renders per-tier hits, stale hits and delete counts;
  the cache badge labels DEL/CLEAR and flags stale (amber) + tier. Simple caches
  that don't supply the optional fields are unchanged.

## 1.13.0

### Minor Changes

- [#31](https://github.com/DavideCarvalho/nestjs-telescope/pull/31) [`53c944f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/53c944f8dd66540813c1ea45fa751b192a0946b3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Cross-link entries and harden extension empty states. The entry detail view gains
  a "Related" panel — jump to every entry of the same family, to the originating
  request a non-request entry was recorded under, or to the queue console for a job.
  Extension dashboard `table` and `topN` panels now render an explicit "No data in
  this window" state instead of a blank/broken-looking panel.

- [#31](https://github.com/DavideCarvalho/nestjs-telescope/pull/31) [`6e66ec3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6e66ec355487c488c8290a13acb99b619895f28d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add Prunes and Exports screens. The pruner now records every prune run (trigger,
  duration, total deleted and real per-type deletions) in a bounded in-memory ring
  exposed at `GET /prunes` alongside the resolved retention config and the predicted
  next run; a new Prunes page surfaces that activity with per-type chips and a gated
  "Prune now". A new Exports page exports filtered entries (by type / window /
  search) to JSON or CSV entirely client-side, with a session export history and a
  dependency-free CSV serializer.

- [#31](https://github.com/DavideCarvalho/nestjs-telescope/pull/31) [`bdc2198`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bdc21987bc90eae6fc95995c99d3de46f0f4fc89) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Surface whether a scheduled cron is currently active. `ScheduledTask` gains a
  `running: boolean | null` field; the `@nestjs/schedule` watcher reads the
  `CronJob.running` flag (null for intervals/timeouts, which expose no state), and
  the Schedules console renders an Active/Stopped badge plus an active/stopped
  summary so a registered-but-stopped cron is obvious at a glance.

## 1.12.1

### Patch Changes

- [#29](https://github.com/DavideCarvalho/nestjs-telescope/pull/29) [`a79c3fa`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a79c3fa6f77c8d02a4150325f082d66d9fdc9227) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship TanStack Intent agent skills (SKILL.md) inside the package.

## 1.12.0

### Minor Changes

- [`74a6563`](https://github.com/DavideCarvalho/nestjs-telescope/commit/74a6563557521edec413b0691a011f9568e140cc) - Surface the Inertia v3 render metadata in the entry detail UI: new **Prepend** and **Rescued** prop rows, a **Once cache** section (cache key → prop, with expiry), a **Scroll** section showing the infinite-scroll cursor (`prev ← current → next`, reset), and **except-once** chips on the partial-reload panel. All fields are read defensively, so older diagnostic payloads still render.

## 1.11.0

### Minor Changes

- [#17](https://github.com/DavideCarvalho/nestjs-telescope/pull/17) [`76228a3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/76228a3a33e4e6d649cd8343646472feff97ed16) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - On-demand CPU flamegraph profiling. A new strictly-opt-in `profiling` option
  (OFF by default) captures V8 CPU profiles around sampled or manually-triggered
  requests via Node's `inspector`, aggregates them into a self/total frame tree,
  and persists them as `cpu_profile` entries correlated to their request batch.
  The dashboard gains a Profiles tab with a dependency-light flamegraph renderer,
  a hot-functions table, and an "arm next N requests" trigger. New headless API
  routes: `GET /profiles`, `GET /profiles/:id`, `GET /profiles/status`, and
  `POST /profiles/arm` (gated by the default-deny mutation guard). When profiling
  is disabled there is ZERO inspector usage and no request-path cost beyond a
  single boolean check.

- [#17](https://github.com/DavideCarvalho/nestjs-telescope/pull/17) [`76228a3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/76228a3a33e4e6d649cd8343646472feff97ed16) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ecosystem improvements across the telescope packages.

  - **Nested trace / batch waterfall view.** Traces and batches now render as a
    nested waterfall, showing child spans nested under their parents with relative
    offsets and durations so the critical path of a request is visible at a glance.
  - **Pulse-style outlier & rollup cards.** New overview cards surface the slowest
    endpoints, slowest queries, slowest jobs, and slowest outbound calls, plus
    load-by-user and CPU/memory history, in the spirit of Laravel Pulse rollups.
  - **Metric-threshold alert rules.** Alerts can now fire on metric thresholds
    (p95 / p99 latency, cache-hit ratio) in addition to existing rules, with
    shared-storage exception deduplication so the same exception is not alerted
    multiple times across replicas.
  - **Improved N+1 detection.** Detection now recognizes the 1+N loop pattern and
    is duration-weighted, reducing false positives and prioritizing the queries
    that actually cost time.
  - **On-demand CPU flamegraph profiling.** A strictly-opt-in `profiling` option
    (OFF by default) captures V8 CPU profiles via Node's `inspector`, aggregates
    them into a self/total frame tree, and persists them as `cpu_profile` entries
    correlated to their request batch. The dashboard gains a Profiles tab with a
    dependency-light flamegraph renderer, a hot-functions table, and an
    "arm next N requests" trigger. When profiling is disabled there is zero
    inspector usage and no request-path cost beyond a single boolean check.
  - **`TelescopeUiModule.forRootAsync`.** The UI module now mirrors
    `TelescopeModule.forRootAsync`, resolving dashboard options via DI.
  - **Realtime dashboards / SSE live-tail.** Dashboards update in realtime over an
    `@Sse` invalidation stream (falling back to polling) with a LIVE indicator.
  - **Packaging hygiene.** `sideEffects` is now declared on each publishable
    package to enable safe tree-shaking for downstream bundlers.
  - **Independent versioning.** The changeset `fixed` group was removed so packages
    version independently going forward.

- [#17](https://github.com/DavideCarvalho/nestjs-telescope/pull/17) [`76228a3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/76228a3a33e4e6d649cd8343646472feff97ed16) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Packaging hygiene + `TelescopeUiModule.forRootAsync`.

  - `TelescopeUiModule` now exposes `forRootAsync({ imports, inject, useFactory, path })`, mirroring `TelescopeModule.forRootAsync`: dashboard options (`assetsDir`) are resolved via DI. As with the core module, the mount `path` is bound at module-build time and is passed statically on the config object (the static value also drives the serve-time asset-base rewrite, so it always matches the route).
  - Added `"sideEffects"` to each publishable package to enable safe tree-shaking for downstream bundlers:
    - `false` on the pure watcher / helper / provider packages (ai, bullmq, cache, events, logs, mail, mikro-orm, mikro-orm-watcher, otel, prisma, redis, redis-watcher, sqs, typeorm, testing) — their entrypoints only re-export classes/types with no module-load side effects.
    - `["./dist/schedule.watcher.js"]` on schedule, which carries a load-bearing bare `import 'reflect-metadata'`.
    - `["./dist/server/*.js", "**/*.css"]` on ui, whose server module/controller emit decorator metadata at load and whose bundled SPA ships CSS.
    - core is left unmarked (treated as side-effecting) because its decorator metadata emit spans many directories.

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.1

### Patch Changes

- [`895ebf2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/895ebf2adb0342a3c648f5c22b27df94328a08da) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a **Workflows** nav tab for durable-workflow entries. The dashboard now knows the `durable`
  entry type (recorded by `@dudousxd/nestjs-durable-telescope`'s watcher), so when a host registers
  that watcher the sidebar shows a "Workflows" tab listing every workflow run/step lifecycle event,
  tagged by `workflow:<name>` / `kind:<local|remote|sleep|signal>`. Without the watcher registered the
  tab stays hidden, like every other watcher-driven nav item.

## 1.7.0

### Minor Changes

- [`4a610c3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4a610c3a3b71d1daa4180da0e92a88a2d7b10472) - Add the Inertia debug panel. The dashboard now renders a rich detail view for
  `inertia` entries (`InertiaBody`): rendered component header with status/partial
  badges, a red version-mismatch (409) callout, the partial-reload Kept/Excluded
  columns, prop classification chips (shared/final/optional/once/merge/deep-merge
  with `matchPropsOn` annotations), deferred groups, the resolved-props tree
  (showing the Recorder's redaction/truncation markers verbatim), history flags and
  page size. Adds `InertiaBadge` (409 / partial / deferred / size chips), an
  `inertia` list summary, and an `Inertia` nav tab that self-hides until the
  `InertiaWatcher` is installed.

### Patch Changes

- [`10c76f1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/10c76f1c0d9c1034e5bffca2d9775cd16e553200) - Inertia panel polish: log on record failure (was silently swallowed) and warn once on
  an unsupported diagnostic version; collapse `InertiaContent` to
  `Omit<InertiaRenderDiagnostic, …>` with a destructure-rest copy; make the
  `isInertiaDiagnostic` guard honest about what it proves; render the Inertia badge in
  the entries table (parity with the cache badge); data-drive the props rows. Adds a
  committed cross-repo wire-contract fixture (`inertia-render.v1.json`) so producer
  drift fails a test.

## 1.6.0

## 1.5.0

### Minor Changes

- [`9e1f318`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9e1f318ba876f3aaf066168b6f8feaa8e20ea5c6) - Fix Slack "Open in Telescope" deep links, and surface cached AI diagnoses on the exception detail page.

  **Slack deep link landed on an empty page.** The "Open in Telescope" button built `<dashboard>#/entries/<type>/<id>`, but `#/entries/<type>` matches the SPA's type-scoped **list** route (`#/entries/:type`) — so the trailing id was ignored and the recipient saw an empty filtered list instead of the entry. The link now points at the real entry-**detail** route, `#/entries/view/:id`, which renders the same `EntryPage` for both `exception` and `client_exception` entries.

  **Auto-mode diagnosis was invisible on the detail page.** In `auto` mode the AI diagnosis is computed and cached per family at first-seen (and may already have been sent to Slack), yet the exception detail page still showed a bare **Diagnose with AI** button as if nothing existed. Now:

  - **Core** adds a read-only `GET <telescope>/api/exceptions/:id/diagnosis` behind the same dashboard read guard as the POST. It serves `{ markdown, cached: true }` from the per-family cache when present and `204 No Content` when absent. It is strictly side-effect-free — it **never** builds context or calls the diagnoser, so a read costs no model tokens.
  - **UI** `DiagnosePanel` fetches that GET on mount (only when `meta.ai.enabled`). A cached diagnosis renders immediately with the **cached** badge and a **Re-run** (force) action; the **Diagnose with AI** button only appears for families that have not been diagnosed yet. The mount fetch shows a subtle "checking" line rather than flashing the button and then swapping it.

## 1.4.0

### Minor Changes

- [`7878ccc`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7878ccc8ca912fd5fc4102c22a5b1c26331443d7) - AI-powered exception diagnosis.

  New package **`@dudousxd/nestjs-telescope-ai`**: `createAiSdkDiagnoser({ model })` implements core's `ExceptionDiagnoser` SPI using the Vercel AI SDK (`ai` is a peer dependency; the model is provider-agnostic — Bedrock / OpenAI / Anthropic / any AI-SDK `LanguageModel`). It turns a captured exception (class, message, stack), its sibling request (route/method/status/duration), and the request's recent **redacted** SQL into a markdown triage report — probable cause, where to look, a suggested fix, and a confidence rating — bounded by `maxOutputTokens` (default 1024) and a hard 30s timeout.

  Core gains an `ai` option (`{ diagnoser, mode? }`, shape defined in core so core stays AI-SDK-free):

  - **On-demand** (default): `POST <telescope>/api/exceptions/:id/diagnose` (behind the normal dashboard read guard) returns `{ markdown, cached }`. Results are cached per error family (bounded, 24h TTL); `?force=true` bypasses. 404 when AI is off or the entry isn't an exception; 502 (safe message) when the diagnoser fails.
  - **Auto** (`mode: 'auto'`): the first time a new exception family is seen, Telescope runs a fire-and-forget diagnosis on the flush path (never blocking capture) and caches it; a firing `new-exception` alert briefly awaits it and attaches it (Slack renders a "Probable cause (AI)" section). `meta.ai` advertises `{ enabled, mode }`.

  The UI adds a **Diagnose with AI** button on exception / client_exception detail pages (visible when `meta.ai.enabled`), rendering the markdown with loading + error states and a **cached** badge with a re-run (force) action.

- [`bc3a0df`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bc3a0df784f31a82753725d9c5e86d75380fee13) - Client error ingestion — Telescope as the frontend error reporter.

  A new **public** endpoint, `POST <telescope>/api/client-errors`, lets browsers report errors directly to Telescope instead of a hand-rolled reporter. Reports are recorded as `client_exception` entries through the normal pipeline, so they compose with everything: the `new-exception` alert, per-type prune/archive, and the dashboard.

  - **Opt-in & ungated.** Configure via `clientErrors: { enabled, maxBodyBytes?, rateLimit?, authorize? }`. Disabled by default (a public surface is opt-in) — while off the endpoint returns 404. It carries no dashboard guard (ordinary users' browsers hit it).
  - **Untrusted-body validation.** Dependency-free structural validation: `message` required, every other field optional with type checks + length caps (message ≤ 2 KB, stack/componentStack ≤ 16 KB, url/userAgent ≤ 2 KB). Invalid → 400 with no echo of the payload. Over the byte cap → 413.
  - **Per-IP rate limit.** A bounded in-memory token bucket (default 60/min, ~10k IPs with oldest-IP eviction). Over the limit → 429. Per-pod best-effort (the effective limit is `perMinute × pods` in a multi-replica deployment).
  - **`authorize` hook.** Runs first; `false` → 403 (a throw is a fail-closed denial). Lets hosts validate a session cookie/header.
  - **Composes.** Records `type: client_exception` with a family hash from name + message + top stack frame (the server exception interceptor now uses the same scheme, so both sources group identically), the `failed` / `client` / `user:<id>` tags, and the captured client IP. The `new-exception` rule now fires for `client_exception` too, using the browser URL and user-agent in place of a server route.
  - **Dashboard.** A new watcher-driven **Client errors** tab (shown only when `clientErrors` is enabled) with a detail view rendering message, stack, component stack, URL, and user-agent.

  See the new recipe: _Reporting frontend errors_.

## 1.3.0

### Minor Changes

- [`7773e0a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7773e0ad120d2678a07e9eebc4631a19c5c8e381) - Hide the Traces page from the dashboard nav when the host has no `traceContext`.

  Entries only get a `trace_id` when the host wires a `traceContext` provider, so an app without one had a permanently empty Traces page sitting as a dead nav item. The dashboard now hides that link — mirroring the watcher-driven nav, which already hides entry types whose watcher isn't registered.

  - Core: `GET /api/meta` now returns `tracesEnabled: boolean` (whether a `traceContext` provider was configured).
  - UI: the **Traces** nav item is hidden when `meta.tracesEnabled === false`. Undefined meta (loading, or an older server predating the field) still shows it — no flash-of-hidden-nav and backward-compatible. The `#/traces` route is untouched, so a direct visit still resolves.

- [`8f9b65e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8f9b65e1b2ec1df664bc173cc76072c6fffdbc59) - Pulse "Slow request hotspots" now require a real slowness threshold.

  Previously the slow-route (and slow-outgoing-HTTP) hotspots were a pure top-N p99 ranking with no floor, so a quiet host surfaced fast routes like `/health` at 18ms as "hotspots" — a false alarm. A route now only counts as a hotspot when its **p99 ≥ `slowRouteMs`** (default `1000`ms, matching the `slow` request-tag threshold and the `HttpClientWatcher` `slowMs` default).

  - Configure via `pulse.slowRouteMs` on `TelescopeModule.forRoot({ pulse: { slowRouteMs } })`.
  - The Overview "Slow requests" stat is now labeled **Slow routes** and means "routes over the slow p99 threshold".
  - The Pulse panel shows a friendly empty state ("No routes over the slow threshold") when nothing qualifies.
  - The "Slowest" entries ranking and N+1 hotspots are unchanged — only slow-ROUTE hotspots gained the threshold.

## 1.2.1

## 1.2.0

### Minor Changes

- [`0ba0c24`](https://github.com/DavideCarvalho/nestjs-telescope/commit/0ba0c24ac68c34ad75fe51775dc7089e308c3126) - Three dashboard improvements:

  - **Criticality-first Overview.** The Overview is reorganized so operational triage sits above the fold: a focused stat row (Requests, **Error rate** = exceptions ÷ requests over the window — red above 5%, Failed jobs, and **Slow requests** = routes over their p99 budget), then Recent failures, a newly-mounted **N+1 query hotspots** card, Slowest, and a **Queues needing attention** card that lists only queues with failed jobs or a large pending backlog (and says "All queues healthy" when clean). Trends and Telescope self-health (throughput, by-type, server, health, retention) move below. All figures derive from data already served by `/pulse` and `/queues` — no new endpoints.
  - **Watcher-driven navigation.** The sidebar Watchers list renders only types whose watcher is registered (from `meta.watchers`); `request` and `exception` always show, direct URLs to hidden types still work, and everything shows while `meta` is loading (no flash of hidden nav).
  - **Dedicated User filter.** The entries filter bar gains a User combobox over the `user:` tag namespace (bare ids + counts); selecting one applies the `tag=user:<id>` filter but renders as a `User: <id>` chip, and a `user:` tag arriving via `?tag=` (the entries-table pivot links) is recognized and shown in the User control instead of the generic tag chip.

## 1.1.0

### Minor Changes

- [`8d91d59`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8d91d59563d731e9125bef65a38651c96ec06e0b) - Gate the dashboard SPA behind `dashboardAuth` when the host enables it.

  On boot the SPA calls `GET /auth/me` and branches three ways:

  - **disabled** (auth not configured → `404`): renders the dashboard exactly as
    before, with no auth UI.
  - **authenticated** (`200`): renders the dashboard plus a **Sign out** button in
    the header (next to the theme/live-tail toggles).
  - **unauthenticated** (`401`): renders an **AuthScreen** chosen from the modes in
    the `401` body — a username/password **Sign in** form (`login` mode, inline
    "Invalid credentials" on failure) or an "Open Telescope from your application"
    instruction card with a **Retry** button (`session`-only mode).

  A `401` from any API call mid-session (expired cookie) flips the app back to the
  AuthScreen automatically. The client gains `auth.me()`/`auth.login()`/
  `auth.logout()`; cookies ride along on the existing same-origin `fetch`, so
  there are no transport changes. With `dashboardAuth` unset, behavior is
  unchanged.

- [`4ceb884`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4ceb8846b7307cf522d841c909d7eaf7fcb1aa4e) - Add retention/prune controls and query EXPLAIN.

  **Retention / prune.** A new `GET /api/retention` reports the configured retention
  window (`entryCount`/`oldestCreatedAt` stay `null` — the storage SPI exposes no
  cheap count/oldest, and Telescope never scans to derive them). `POST /api/retention/prune`
  runs an on-demand prune behind the existing default-deny mutation gate
  (`authorizeAction`); it 403s when mutations are disabled and 400s when no `prune`
  window is configured. The Overview page gains a Retention card with a confirm-gated
  "Prune now" button, shown only when `meta.pruneEnabled` (prune window AND mutations).

  **Query EXPLAIN.** A new host hook
  `explainQuery?: (sql, bindings) => Promise<unknown>` lets the host run an
  engine `EXPLAIN` (it brings its own connection/dialect — e.g. MySQL
  `EXPLAIN FORMAT=JSON`). `POST /api/queries/explain` loads the query entry and
  returns `{ plan }`; a hook throw surfaces as a clean `{ message }`. The query
  entry detail gains an "Explain" button (only when `meta.explainEnabled`) that
  renders the plan JSON with loading/error states.

  `TelescopeMeta` gains `pruneEnabled` and `explainEnabled`.

- [`15e3e90`](https://github.com/DavideCarvalho/nestjs-telescope/commit/15e3e903d82616966342feeb966fbd44ad6a2631) - Add user drill-down: pivot from any request entry to all of a user's activity.

  A new built-in **`userTagger`** (in `BUILTIN_TAGGERS`) tags request entries with
  the authenticated user's identity as `user:<id>`. It reads `content.user`,
  preferring `id`, then `_id` (Mongo), then `email` — cheap property reads gated to
  request entries, never throwing on odd content shapes. Whatever `resolveUser`
  returns becomes a filterable tag.

  The dashboard turns that tag into a one-click pivot, reusing the existing
  indexed-tag filter (no new query dimension): user-tagged rows show a `user:<id>`
  chip in the entries table, and the entry detail view offers **"View all activity
  for this user"**. Both navigate to the all-types entries list pre-filtered by the
  tag (`#/entries?tag=user:<id>`), which the entries page now seeds from the `?tag=`
  query string — the same deep-link mechanism as `?familyHash=`.

### Patch Changes

- [`d200d15`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d200d158f927e6a67396e594b32bfd0a0b3424e4) - Bound memory by design at capture time, fixing a production OOM incident.

  A host hit a GC death spiral at its container limit. There was no unbounded leak:
  the heap was a retained _working set_ — `prune.after × ingest rate × bytes per
entry` — amplified by `redact()` deep-cloning fat enumerable object graphs (a
  host's `req.user` ORM entity → tens-of-KB..MB clones per entry), high-cardinality
  cache capture volume, and the Recorder ring never nulling drained slots (stale fat
  entries lingered up to capacity). The synchronous `redact()` detach is
  load-bearing and must stay synchronous, so the fix bounds the clone instead of
  deferring it.

  - **Bounded redaction (on by default).** `redact()` now applies hard, overridable
    bounds: `maxDepth` (8), `maxStringLength` (8_192), `maxArrayLength` (200), and a
    per-call `maxNodes, maxContentBytes (16KB serialized-byte budget — the deterministic bytes-per-entry cap)` (5_000) node budget that caps a mega-graph regardless of its
    shape. Defaults are generous — a normal request / query / cache entry is cloned
    byte-identically; bounds only bite on pathological content. Key/path masking,
    cycle-safety, sync-and-never-throwing behavior, and the public `redact()`
    signature are unchanged. A new sibling `redactBounded()` also returns whether
    truncation happened.
  - **Recorder hardening.** `drain()` nulls drained ring slots so flushed fat
    entries aren't retained afterward. A new `truncatedCount` self-metric counts
    entries whose content hit a bound; it surfaces automatically in
    `GET /telescope/api/health`, and the dashboard Overview adds a _Truncated_ stat
    card (ui patch).
  - **High-volume guidance.** When `prune` is set but `sampling` is empty, boot logs
    a one-line INFO pointing at per-type sampling (e.g. `sampling: { cache: 0.1 }`)
    to bound store volume on high-cardinality streams.

- Updated dependencies [[`c2423f3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c2423f330be3f9b92c0dbf2348220bf8740dab86), [`d8173d4`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d8173d4c5d362814aa0fcdb0bfb35fd353b3d1a8), [`d200d15`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d200d158f927e6a67396e594b32bfd0a0b3424e4), [`953ae12`](https://github.com/DavideCarvalho/nestjs-telescope/commit/953ae12fd35e42df3b806d6bbec6b49e3e3c71fb), [`4ceb884`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4ceb8846b7307cf522d841c909d7eaf7fcb1aa4e), [`15e3e90`](https://github.com/DavideCarvalho/nestjs-telescope/commit/15e3e903d82616966342feeb966fbd44ad6a2631)]:
  - @dudousxd/nestjs-telescope@2.0.0

## 1.0.0

### Minor Changes

- [`1f00e62`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1f00e62c8e60482b64251813680a5f866ef1619a) - Make the telescope mount path configurable. `TelescopeModule.forRoot({ path:
'observability' })` and `TelescopeUiModule.forRoot({ path: 'observability' })`
  now serve the dashboard at `/observability` and the API at `/observability/api`.
  The `path` option (normalized — leading/trailing slashes stripped) defaults to
  `'telescope'`, so behavior is byte-identical when unset.

  Core binds the API controller route at module-build time via a per-`forRoot`
  subclass of `TelescopeController` (`dynamicController(...)`), preserving all
  route/DI metadata. `forRootAsync` accepts a static `path` field (the route must
  be known synchronously). The request-capture middleware now skips the configured
  path instead of a hardcoded `/telescope`, and the resolved core config exposes
  `path`.

  The UI is **not** rebuilt per-path: the SPA keeps the `/telescope/` Vite base
  placeholder and the UI controller rewrites the asset base to `/<path>/` at serve
  time, injecting `window.__TELESCOPE_BASE__` so the client derives its API base
  (`createTelescopeClient` falls back to `/telescope/api` when the global is
  absent; an explicit `baseUrl` still wins). Asset traversal safety is unchanged.

- [`090cd1f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/090cd1ff871dbe46c1c877a26f90496550b5304c) - Dashboard insights, charts, and trace grouping. Core gains a `StatsService` +
  `GET /stats` endpoint with per-type analytics (latency p50/p95/p99, query-family
  breakdown, cache hit/miss ratio, request status breakdown) and an `EntryQuery.traceId`
  filter across all storages. The schedule watcher now tags scheduled runs with a stable
  `schedule` tag. The dashboard adds a per-type insights header with Recharts cards, cache
  hit/miss badges, a working Schedule view (job entries tagged `schedule`), and a
  `#/traces/:traceId` page that groups every entry sharing an OpenTelemetry trace.

- [`b7326b3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b7326b33d8d55b5f1ac5de4256f5e1980278699e) - Add a **Dumps** dev tool. Call `telescopeDump(value, 'label')` anywhere in your
  code (no dependency injection at the call site) and the value shows up in a new
  "Dumps" tab in the dashboard — a request-correlated alternative to
  `console.log`. `telescopeDump` forwards to a module-level sink that
  `TelescopeService` wires on construction and detaches on shutdown (it is a
  no-op until wired, so importing it in shared code never crashes outside a
  Telescope-enabled app). `TelescopeService.dump(value, label?)` records a `dump`
  entry whose `value` is redacted by the Recorder like any other content and
  correlated to the active batch. Core exports `telescopeDump`, `setTelescopeDump`,
  `DumpContent`, and `EntryType.Dump`. The UI gains a `dump` entry type, a detail
  view that renders the label and pretty-printed JSON value (guarding
  non-serializable values), and a table summary showing the label or a value
  preview.

- [`bfc0e26`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bfc0e268388b5563d05c24e4de6ff99c74d1201a) - Add free-text search over entries. `EntryQuery` gains a `search?: string` field —
  a case-insensitive substring matched against the entry's serialized `content`, so
  you can find a request by uri, a query by sql, a cache op by key, or an exception
  by message. It is applied as an extra AND predicate, so it composes with every
  other filter and with keyset pagination, and it is independent of `omitContent`
  (the match runs over the stored content before any projection).

  Every storage provider implements it: sqlite (`content LIKE '%term%'`), mikro-orm
  (`raw('content')` `$like` so the JSON column is matched as text, not JSON-encoded),
  in-memory and redis (case-insensitive substring over `JSON.stringify(content)` in
  the predicate / in-scan post-filter). The `GET /entries` endpoint reads a non-empty
  `search` query param, and the dashboard entries filter bar gains a "Search content"
  input (commits on Enter/blur, never on keystroke) shown as a clearable
  `search:"term"` chip that "Clear filters" drops.

- [`6817fe6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6817fe62775b1ff847fdb1038d3298e7709569e0) - Add exception grouping to the per-type stats insight. `summarizeStats` now
  returns `exceptions?: ExceptionGroupStats[]` for the `exception` type: groups
  the window's exception entries by family key (the entry's `familyHash`, or a
  `${class}: ${message}` fallback when null) with `count`, `lastAt`, `class`,
  `message`, and a per-bucket `overTime` series aligned to the report's buckets,
  sorted by count desc then last-seen desc (top 8). The Exceptions view renders an
  "Exception groups" list — class (mono), truncated message, count, relative
  last-seen, and an inline over-time sparkline — each row drilling through to that
  group's occurrences via `?familyHash=`.

- [`20ceb87`](https://github.com/DavideCarvalho/nestjs-telescope/commit/20ceb878cd4495dfbc7a3c71d882ae216a633757) - Surface JSON export and retention/sampling in the dashboard.

  Core: `TelescopeMeta` (`GET /meta`) now reports the resolved `retention`
  (`{ afterMs, keepLast }` from `prune`, or `null` when unbounded) and the
  resolved per-type `sampling` rates, sourced from the resolved config.

  UI: the entry-detail page gains a "Copy JSON" / "Download JSON" toolbar that
  exports the full `EntryWithBatch` (`telescope-entry-<id>.json`); the trace page
  gains a "Download JSON" button exporting all trace entries as a JSON array
  (`telescope-trace-<traceId>.json`). The dashboard header shows a subtle
  retention indicator (e.g. "retention: 5m", or "none" when unbounded) with a
  sampling tooltip when any type is down-sampled below 1. New `toPrettyJson`,
  `copyJson`, and `downloadJson` export utilities back the buttons; clipboard
  absence degrades gracefully.

- [`d3ccf7d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d3ccf7dfdbe515b7efe134ca0d7d0cfb901bc8a2) - Add a "Telescope health" card to the Overview page rendering `GET /health`:
  per-capture cost (µs), buffer pressure + high-water, flush durations, and dropped
  count (green when keeping up, red with an overflow/store breakdown when shedding).
  Makes Telescope's own overhead visible at a glance.

- [`9d8eb65`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9d8eb6562a7584801d5aa8b74491091f0fade5f9) - Let operators **enqueue (send) a new job/message** onto a queue from the dashboard.

  Core adds an optional `enqueue?(queue, payload, opts, ctx)` method to the
  `QueueManager` SPI and a new `POST /telescope/api/queues/live/:driver/:queue/enqueue`
  route. Unlike the other mutations it carries a JSON body (`{ name?, payload }`),
  so it lives on its own path rather than under `:action` — but it flows through the
  same default-deny `TelescopeActionGuard` as `retry` / `remove` / `redrive`: the
  guard recovers the `enqueue` action from the request path, so without an
  `authorizeAction` callback it returns `403`. The route returns `400` when the
  payload is absent and `404` when the driver is unknown or doesn't implement
  `enqueue`. `enqueue` is added to `QUEUE_ACTIONS` and advertised in the
  `/queues/live` `actionsByDriver` capabilities when a manager implements it.

  `BullMqQueueManager` implements `enqueue` via the real `Queue.add(name, data)`
  (defaulting the name to `manual`), returning the new job id.

  The UI gains an "Send message" form on the queue console — shown only when the
  selected driver advertises `enqueue` and mutations are enabled. It parses the
  payload textarea as JSON (invalid JSON surfaces inline without calling the API),
  posts via a new `queueEnqueue` client method, and on success confirms and
  refreshes the queue counts/jobs. A `403` surfaces inline as "Not authorized".

- [`9b6f12f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9b6f12f8b00f847f52c1adaa043c1e32d0b64598) - Add the live queue management console. The Queues area now leads with a
  master-detail manager (`#/queues`): a live queue list with per-state count
  badges and paused indicators, state tabs, a dense job table with cursor-based
  "Load more", and a slide-over job detail drawer (pretty-printed payload/opts,
  timestamps, attempts, and stacktrace for failures). Retry / remove / promote
  and "Retry all failed" actions render only when the driver advertises the
  action and `mutationsEnabled` is true (server-side default-deny still enforced;
  403s surface a friendly "Not authorized" hint). The Phase-3 throughput/runtime
  metrics now live under a `Metrics` sub-tab (`#/queues/metrics`) so there is a
  single, coherent "Queues" nav entry.

- [`ba7eeae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/ba7eeaeb23da9d054f5ef40b769f7738607305e6) - Add a gated "Redrive DLQ" action to the queue management UI. On the failed tab /
  queue header, `RedriveDlqButton` is shown only when the driver advertises
  `'redrive'` (`capabilities.actionsByDriver[driver]`) and `mutationsEnabled` is
  true — so it surfaces for SQS-style DLQ drivers and stays hidden for BullMQ. It
  confirms before firing (it moves messages back to the source queue) via the
  existing `useQueueAction()` with `action: 'redrive'`, and a 403 surfaces inline as
  "Not authorized".

- [`3778c8d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3778c8d9fbbfeb96e0e32b5ebed63751a9debcd7) - Add Laravel-Telescope-style per-type navigation and entry filtering to the
  dashboard UI. The chrome is now a left sidebar with the existing top-level nav
  (Overview, Entries, Pulse, Queues) plus a grouped "Watchers" section linking to
  each entry type (Requests, Queries, Exceptions, Jobs, Mail, Cache, Schedule,
  HTTP Client), each with a per-type color dot and routing to the entries list
  pre-filtered to that type via `#/entries/<type>`. The entries list gains a
  compact filter bar: an active-type chip with a clear affordance, a tag text
  filter wired into the backend-supported `tag` query param, a "Clear filters"
  control, and type/tag-aware empty states. Entry detail moves to
  `#/entries/view/:id` to disambiguate from the per-type list route.

- [`25fcff4`](https://github.com/DavideCarvalho/nestjs-telescope/commit/25fcff41ea9783d8a8085f5a2b7358464d3d74be) - Add a Horizon-style Overview landing page (now the index route `#/`) with a stat
  cards row (entries, requests, exceptions, jobs, jobs/min, failed jobs), a
  throughput area chart, a by-type stacked-area chart, and recent-failures /
  slowest lists linking to entry detail. Introduce dark-themed Recharts chart
  primitives (`AreaChartCard`, `StackedAreaChartCard`, `BarChartCard` + shared
  `chart-theme`), exported from `/react`, with all Recharts imports isolated to
  `src/react/components/charts/*`. Re-skin the Pulse throughput-by-type and the
  Queues failure-rate visualizations onto the new charts.

- [`c0804b9`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c0804b96523deeb92762a03aa6b1ccee16598cef) - Add a global live-tail pause/resume toggle to the dashboard. A `Live`/`Paused`
  control in the header freezes all polling so you can inspect a moment in time.
  `TelescopeProvider` now exposes a live-tail flag via `useLiveTail()`/`usePaused()`,
  and every polling query hook (entries, meta, pulse, stats, queues, timeseries,
  traces, live queues, queue jobs) sets `refetchInterval: false` while paused and
  resumes at the normal interval when live. Default is live (unchanged behavior).
  Manual navigation/clicks still fetch — only the interval is gated.

- [`6fa0946`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6fa0946f5543868704864af2e32793eb448ac827) - Add the `model` and `redis` entry types (`EntryType.Model` / `EntryType.Redis`)
  and their content shapes `ModelContent { action, entity, id, changes }` and
  `RedisContent { command, args, durationMs }`, consumed by the new
  `@dudousxd/nestjs-telescope-mikro-orm-watcher` and
  `@dudousxd/nestjs-telescope-redis-watcher`. The UI gains Models/Redis nav types,
  `ModelBody` / `RedisBody` detail renderers, and table summaries
  (`<action> <entity>#<id>` for model, `<COMMAND> <args-preview>` for redis).

- [`d507547`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d507547df3c13e76e90b8a97c4e3e1d8aef25bd1) - Add OpenTelemetry trace linking. The new `@dudousxd/nestjs-telescope-otel`
  package implements core's `TraceContextProvider` SPI by reading the active
  OpenTelemetry span via `@opentelemetry/api` (`OtelTraceContextProvider`,
  optional peer, read-only — never creates or exports spans, degrades to `null`
  when no span/API is present). Core gains the `TraceContextProvider` SPI,
  `traceId`/`spanId` on each `Entry`, and a `meta.traceLink` template so the UI
  can deep-link entries to a trace backend; the MikroORM storage provider adds the
  corresponding trace columns so the ids survive persistence. The Redis storage
  provider now reconstructs `traceId`/`spanId` when reading entries back, and the
  dashboard shows a Trace row in the entry detail with a clickable deep-link when
  `traceLink` is configured.

- [`cad6dae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/cad6dae0dba4f22e476d78c23ce2f74f7f6848e4) - Two pulse/dashboard UX improvements.

  N+1 query hotspots are now aggregated by query family instead of listed per
  request. `summarizePulse` returns `NPlusOneHotspot[]` — one row per family with
  `perRequest` (worst single-request repetition), `requests` (how many requests
  tripped the threshold), `total` (sum of repetitions), and `sampleBatchId` (the
  worst batch). Identical queries that previously appeared as several identical
  rows now collapse into a single hotspot, sorted by total repetitions. The Pulse
  panel renders `×{perRequest} per request · {requests} requests · {total} total`
  and links each hotspot to its query family (`#/entries/query?familyHash=…`).

  The entries table now surfaces a subtle `trace:<id>` chip on any row that
  belongs to a trace, linking straight to `#/traces/:traceId` so traces are
  discoverable from the list without opening an entry's detail. Rows without a
  trace show nothing extra.

- [`c8596c8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c8596c85712880cb235e8cce059a1d93d339e9bd) - Add slow-request hotspots to the pulse panel — like the N+1 hotspot, but for
  endpoints: which routes are consistently slow, aggregated by route with `p99`,
  `p50`, and request `count`.

  Request entries now carry a readable, normalized **route family** as their
  `familyHash` (e.g. `"GET /api/base/:id/mel"`), via a new pure
  `normalizeRoute(method, url)` helper that strips the query string and replaces
  id-like path segments (UUID / all-digits / long hex) with `:id`. The route
  family doubles as the human label and indexes on the existing `family_hash`
  column, so the new `slowRoutes` aggregation runs entirely over content-less
  columns in the existing two-pass pulse scan — no `content` reads, no hydration.

  The pulse panel renders a "Slow request hotspots" section; each row links
  through to that route's request entries (`familyHash` filter).

- [`abde392`](https://github.com/DavideCarvalho/nestjs-telescope/commit/abde39264effb31b0524cc4fa89a335276c8dccb) - Capture requests under a global prefix, and make query-shape insights actionable.

  Core: the request-capture middleware no longer relies on NestJS module routing,
  which silently scoped the catch-all to `/` whenever the host called
  `setGlobalPrefix(...)`. New `telescopeRequestCapture(service)` factory lets hosts
  register the capture globally (`app.use(...)` in bootstrap), and a
  `registerRequestMiddleware: false` option disables the built-in registration.
  Telescope's own dashboard routes are skipped inside the middleware instead of via
  `.exclude()` (which breaks with catch-all routes). The query-family label now
  tolerates content shapes that omit `slow`/`connection` (e.g. the MikroORM logger).

  UI: the "Slowest query shapes" chart uses a horizontal, truncated layout (full
  SQL on hover) so long labels no longer overlap, and each bar is clickable —
  drilling into the entries list filtered to that query family.

- [`8ff32a2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8ff32a2cc95775224eea3377460d91674dfda47f) - Capture richer request detail. The request middleware now records the parsed
  request body as `payload` and the authenticated user as the new
  `RequestContent.user` field — read in the `res.on('finish')` callback (after the
  host body-parser and guards have run). The user defaults to the raw request's
  `user` (the Passport/guard convention) and is customizable via the new
  `TelescopeModuleOptions.resolveUser(request)` hook. Both flow through the
  Recorder's redaction (passwords/tokens masked). The request detail UI gains
  collapsible Headers (with count), a pretty-printed Payload section, and a User
  section ("anonymous" when none).

- [`b14a201`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b14a20175eae3d3017e8cbc068d367a03f634175) - Add a live Schedule console for `@nestjs/schedule` scheduled tasks, mirroring the
  Queues console.

  Core gains a `ScheduleManager` SPI (`ScheduledTask` = name, kind, schedule,
  nextRunAt, lastRunAt, lastDurationMs, lastStatus), a `ScheduleManagerRegistry`
  that boots the configured managers, a `scheduleManagers?` option, and a
  read-guarded `GET /telescope/api/schedules/live` returning `{ tasks }`.

  The `@nestjs/schedule` watcher now also implements `ScheduleManager`: its
  `listTasks()` reads `SchedulerRegistry` (via `moduleRef`) for the registered
  cron/interval/timeout names, cron expression and next fire time, and merges its
  own in-memory last-run map (additive to the existing entry-recording path). It
  degrades gracefully — a missing/partial registry yields a null-filled or empty
  list and never throws.

  The UI adds a read-only `#/schedules` page (a table of name, kind, schedule,
  next run, last run, duration, status) that polls like the queues console and
  honors the live-tail pause, a `schedulesLive()` client method + `useSchedulesLive()`
  hook, and a "Schedules" sidebar console link (distinct from the per-type
  Schedule entries tab).

- [`a90ef56`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a90ef569ba12484bece07d8de2045e13ff2ff528) - Two dashboard additions:

  - **Slow outgoing HTTP hotspots.** The `http_client` watcher now records a
    grouping `familyHash` of `${method} ${host}${normalizedPath}` (via a new
    `normalizeHttpTarget` helper that keeps the host and `:id`-normalizes the
    path), so outbound calls to the same external endpoint aggregate regardless of
    ids. Pulse gains `slowOutgoing: SlowRouteHotspot[]` — top-N external targets by
    p99 (count + p99/p50 over `durationMs`), computed entirely from content-less
    columns (no hydration). The UI renders a "Slow outgoing HTTP" section in the
    Pulse panel, each row deep-linking to `#/entries/http_client?familyHash=…`.

  - **Server stats card.** A read-guarded `GET /telescope/api/server-stats`
    endpoint returns a point-in-time Node process-health snapshot
    (`uptimeSec`, `memory` RSS/heap MB, `cpu` user/system ms, `eventLoopDelayMs`,
    `instanceId`). Event-loop delay is read from a `perf_hooks.monitorEventLoopDelay`
    histogram started once at service init and degrades to `null` when unavailable.
    The UI Overview page shows a polled "Server" card (honors pause) via the new
    `serverStats()` client method and `useServerStats()` hook.

- [`f144584`](https://github.com/DavideCarvalho/nestjs-telescope/commit/f144584f7be7bda2a1189ddfd0b9fd461d2e1e86) - Turn the entries tag filter into an accessible autocomplete. Typing now queries
  `GET /telescope/api/tags?prefix=` and surfaces matching tags with their entry
  counts (top 10, sorted by count desc); picking one applies it as the active tag
  filter and shows a clearable chip. Adds a `tags(prefix?)` client method and a
  `useTags(prefix)` hook (non-polling reference data) plus the `TagCount` type.

- [`7b6636b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7b6636b54438427cd53ea0cbedd186b77d807169) - Add `@dudousxd/nestjs-telescope-ui`: a bundled React dashboard served by
  `TelescopeUiModule` (no host frontend deps), with an Entries view (type tabs,
  polling) and correlated entry detail. The same building blocks are exported at
  `/react` (components + hooks) and `/client` (typed API client) so consumers can
  compose their own dashboard. Core's request middleware now also excludes the
  `/telescope` UI routes from capture.

- [`e64f35a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e64f35a1bb7cae15b2ef24404888463d04f81eef) - Add throughput time-series. `GET /telescope/api/timeseries?window=1h&buckets=60`
  returns bucketed entry counts (total + per type) computed from stored entries
  (`TimeseriesService` + `bucketTimeseries`), with optional `type`/`tag` filters.
  The dashboard renders it as a zero-dependency SVG `Sparkline` on the Pulse page
  (also exported at `/react`).

- [`4892ef6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4892ef61e45e5486d34c7ec82764e6767fe8233d) - Add a **Traces list** — browse recent distinct OTel traces instead of only
  drilling in from a single entry. Core gains a pure `summarizeTraces` that groups
  windowed entries by `traceId` (skipping null trace ids) into per-trace summaries
  (`entryCount`, distinct sorted `types`, `firstAt`/`lastAt`, summed
  `totalDurationMs`, optional `rootLabel`), a `TracesService` that scans the store
  content-less over a window, and a `GET /telescope/api/traces?window=&limit=`
  endpoint (read-guarded, mirrors `/timeseries`). The dashboard adds a **Traces**
  nav item and a `#/traces` page listing recent traces — each row shows the root
  label (or traceId), the type dots present, entry count, total duration, and
  relative time, and links to the existing `#/traces/:traceId` grouping page.

- [`205eabe`](https://github.com/DavideCarvalho/nestjs-telescope/commit/205eabe2c3a34496f2dea608e89887407f4997df) - Add a Cmd+K / Ctrl+K command palette and a light/dark theme toggle to the
  dashboard. The palette is a centered modal (backdrop/Escape close, focus-trapped
  input, ArrowUp/Down wrapping highlight, Enter to navigate via the hash router)
  whose action list is built from `ENTRY_TYPES` plus the static page targets so it
  stays in sync. A header "⌘K" badge also opens it. The theme toggle (dark default)
  persists to `localStorage`, restores on load, and applies a `light`/`dark` root
  class; a scoped `.light` stylesheet flips the most common dark surfaces, text, and
  borders for a usable light mode (full per-component theming is a follow-up).

- [`7797a2a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7797a2a1554aff49bb59f5ca1b204974a7e04a41) - Render the new `event` and `log` entry types: nav entries (Events/Logs), an event
  detail (name + pretty payload + listener count) and a log detail (level badge +
  message + context), plus table summaries (`event` name / `[level] message`).

- [`8dcded2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8dcded2a46582799e8176a83136a56cd1ac1f7fb) - Richer dashboard charts: per-type stacked-bar throughput (with a legend) on the
  Pulse page, and a per-queue throughput sparkline column on the Queues page (via
  a `tag`-filtered timeseries). New `StackedBars` / `QueueSparkline` components +
  `stackedBarLayout`/`deriveTypes`/`colorForType` helpers exported at `/react`;
  `QueuesPanel` gains an optional `sparkline` render-prop.

- [`d4c3986`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d4c398631c2a77867b26a4b9bc86db073d9dd8c3) - Complete the dashboard with Pulse (per-type counts, slowest entries, top
  exceptions, N+1 hotspots) and Queues (throughput, failure rate, runtime/wait
  percentiles) views, each with a window selector. Typed the `pulse()`/`queues()`
  client responses and exported `PulsePanel`/`QueuesPanel`/`WindowSelect` at
  `/react`. Added an e2e that serves the real built bundle.

- [`e995e26`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e995e266c87673f865164e76c7c930eb5170f6ac) - Show a request's batch as a compact timeline/waterfall in the entry detail. When
  viewing a `request` entry that captured children (queries, cache, jobs, …), a new
  `RequestTimeline` renders one row per batch entry ordered by `sequence`: a type
  dot, a short label, a horizontal duration bar scaled to the slowest entry in the
  batch, and the `durationMs`. Each row links to that child's detail. This makes
  "where did the time go in this request" obvious without leaving for a trace
  viewer. Null-duration children render with a minimal bar, and large batches cap
  at 50 rows with a "+N more" note.

### Patch Changes

- [`da0aa24`](https://github.com/DavideCarvalho/nestjs-telescope/commit/da0aa245b4efac6b95037339b0b81b50305bf9d9) - Serve the dashboard `index.html` with `Cache-Control: no-store` and the hashed
  asset bundles with a long immutable cache. Previously index.html had no cache
  headers, so browsers kept loading a stale bundle across upgrades — the classic
  "a widget is stuck loading / shows old labels after deploying a new version".
- Updated dependencies [[`73b50ad`](https://github.com/DavideCarvalho/nestjs-telescope/commit/73b50ad00193127271fdec36ad080d2858045922), [`9126bb0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9126bb04777cdaec6af3b0a1c5fe6f91d055ce82), [`1f00e62`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1f00e62c8e60482b64251813680a5f866ef1619a), [`090cd1f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/090cd1ff871dbe46c1c877a26f90496550b5304c), [`b7326b3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b7326b33d8d55b5f1ac5de4256f5e1980278699e), [`bfc0e26`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bfc0e268388b5563d05c24e4de6ff99c74d1201a), [`7797a2a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7797a2a1554aff49bb59f5ca1b204974a7e04a41), [`6817fe6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6817fe62775b1ff847fdb1038d3298e7709569e0), [`20ceb87`](https://github.com/DavideCarvalho/nestjs-telescope/commit/20ceb878cd4495dfbc7a3c71d882ae216a633757), [`1dd4db0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1dd4db0f3cd46d04b35ac112343cfb424c2d3190), [`a9f517c`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a9f517c076461aef55cfb90d072ec38427ace91b), [`9d8eb65`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9d8eb6562a7584801d5aa8b74491091f0fade5f9), [`418f1f0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/418f1f0421948b40b25f845441a716fa4c6655c2), [`e76980d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e76980ddd7ee740f1b337a422a98ca98d97a007e), [`80c8f97`](https://github.com/DavideCarvalho/nestjs-telescope/commit/80c8f9769c8ab9ee724635086740910bc4d44ea3), [`e14ac60`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e14ac603551372fc3767c63a349c509582b5e6ab), [`6fa0946`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6fa0946f5543868704864af2e32793eb448ac827), [`d507547`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d507547df3c13e76e90b8a97c4e3e1d8aef25bd1), [`affd07e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/affd07e4cb9ee85cfabaabed424833e8c638d04a), [`6a4d8d5`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6a4d8d56321d3840fe64e646130ccfdafcfb1bdd), [`c1f1ec9`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c1f1ec903d470d6b884924e2713de305b61b7481), [`cad6dae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/cad6dae0dba4f22e476d78c23ce2f74f7f6848e4), [`c8596c8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c8596c85712880cb235e8cce059a1d93d339e9bd), [`c4222b1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c4222b16ef4c0fc9c61694eb67033f03369ff24e), [`de29d2f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/de29d2f519b1f25bc702c9dcc737d99b4751c8c9), [`10a3bc2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/10a3bc224f6e0b1a237e1e7631acad70493b4c12), [`abde392`](https://github.com/DavideCarvalho/nestjs-telescope/commit/abde39264effb31b0524cc4fa89a335276c8dccb), [`8ff32a2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8ff32a2cc95775224eea3377460d91674dfda47f), [`5f2eddd`](https://github.com/DavideCarvalho/nestjs-telescope/commit/5f2eddd0ed5d72bf1de323b45870d7ddcaf64349), [`b14a201`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b14a20175eae3d3017e8cbc068d367a03f634175), [`a90ef56`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a90ef569ba12484bece07d8de2045e13ff2ff528), [`593bcc8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/593bcc85ad6558040c62ba66bd1e5e0cbe5a6ac7), [`7b6636b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7b6636b54438427cd53ea0cbedd186b77d807169), [`e64f35a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e64f35a1bb7cae15b2ef24404888463d04f81eef), [`4892ef6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4892ef61e45e5486d34c7ec82764e6767fe8233d)]:
  - @dudousxd/nestjs-telescope@1.0.0
