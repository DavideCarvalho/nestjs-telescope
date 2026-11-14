---
"@dudousxd/nestjs-telescope-ui": patch
---

⌘K console search now degrades gracefully when the app doesn't serve the search endpoint (a console mounted with `routes: false` and the host's own controllers). A 404/405/501 from `/consoles/search` marks search as not enabled for the page's life: the dialog says "Search isn't enabled in this app." once (never "Nothing found" or a retry loop), the endpoint is not asked again, and the ⌘K trigger and shortcut are hidden (kept for console-local commands). A 404 from `/consoles` keeps the plain brand and is no longer re-requested on every search. Other failures (5xx, network) keep the quiet error line with Retry.
