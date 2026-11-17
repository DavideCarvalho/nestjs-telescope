---
"@dudousxd/nestjs-telescope-ui": minor
---

Console filters now live in the URL, so a filtered view can be shared, bookmarked and reloaded, and Back/Forward step through it: Entries (`tag`, `q`, `familyHash`), the time window on Overview, Pulse, Traces, Queues metrics and AI, a trace's tab, the open queue and its state tab, the Fleet role, the open profile and AI run, and the Exports form. They sit in the hash's query (`#/entries/request?tag=user:42&q=checkout`), read and written with nuqs through a hash adapter in the console kit; a value at its default is left out, so existing `#/<page>` links (including `?tag=` and `?familyHash=` pivots) open as before. Submitting a search rewrites the history entry; picking a filter, tab or row adds one.
