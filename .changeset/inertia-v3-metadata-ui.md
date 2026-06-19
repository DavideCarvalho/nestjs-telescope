---
"@dudousxd/nestjs-telescope-ui": minor
---

Surface the Inertia v3 render metadata in the entry detail UI: new **Prepend** and **Rescued** prop rows, a **Once cache** section (cache key → prop, with expiry), a **Scroll** section showing the infinite-scroll cursor (`prev ← current → next`, reset), and **except-once** chips on the partial-reload panel. All fields are read defensively, so older diagnostic payloads still render.
