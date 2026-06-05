---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Fix Slack "Open in Telescope" deep links, and surface cached AI diagnoses on the exception detail page.

**Slack deep link landed on an empty page.** The "Open in Telescope" button built `<dashboard>#/entries/<type>/<id>`, but `#/entries/<type>` matches the SPA's type-scoped **list** route (`#/entries/:type`) — so the trailing id was ignored and the recipient saw an empty filtered list instead of the entry. The link now points at the real entry-**detail** route, `#/entries/view/:id`, which renders the same `EntryPage` for both `exception` and `client_exception` entries.

**Auto-mode diagnosis was invisible on the detail page.** In `auto` mode the AI diagnosis is computed and cached per family at first-seen (and may already have been sent to Slack), yet the exception detail page still showed a bare **Diagnose with AI** button as if nothing existed. Now:

- **Core** adds a read-only `GET <telescope>/api/exceptions/:id/diagnosis` behind the same dashboard read guard as the POST. It serves `{ markdown, cached: true }` from the per-family cache when present and `204 No Content` when absent. It is strictly side-effect-free — it **never** builds context or calls the diagnoser, so a read costs no model tokens.
- **UI** `DiagnosePanel` fetches that GET on mount (only when `meta.ai.enabled`). A cached diagnosis renders immediately with the **cached** badge and a **Re-run** (force) action; the **Diagnose with AI** button only appears for families that have not been diagnosed yet. The mount fetch shows a subtle "checking" line rather than flashing the button and then swapping it.
