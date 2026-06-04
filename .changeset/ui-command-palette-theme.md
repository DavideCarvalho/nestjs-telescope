---
'@dudousxd/nestjs-telescope-ui': minor
---

Add a Cmd+K / Ctrl+K command palette and a light/dark theme toggle to the
dashboard. The palette is a centered modal (backdrop/Escape close, focus-trapped
input, ArrowUp/Down wrapping highlight, Enter to navigate via the hash router)
whose action list is built from `ENTRY_TYPES` plus the static page targets so it
stays in sync. A header "⌘K" badge also opens it. The theme toggle (dark default)
persists to `localStorage`, restores on load, and applies a `light`/`dark` root
class; a scoped `.light` stylesheet flips the most common dark surfaces, text, and
borders for a usable light mode (full per-component theming is a follow-up).
