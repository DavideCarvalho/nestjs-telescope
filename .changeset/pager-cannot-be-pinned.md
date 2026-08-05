---
'@dudousxd/nestjs-telescope-ui': patch
---

Stop a provider that ignores `query.page` from freezing a paged table's pager.

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
