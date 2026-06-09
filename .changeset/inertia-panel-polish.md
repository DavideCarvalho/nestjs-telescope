---
"@dudousxd/nestjs-telescope-inertia-watcher": patch
"@dudousxd/nestjs-telescope-ui": patch
---

Inertia panel polish: log on record failure (was silently swallowed) and warn once on
an unsupported diagnostic version; collapse `InertiaContent` to
`Omit<InertiaRenderDiagnostic, …>` with a destructure-rest copy; make the
`isInertiaDiagnostic` guard honest about what it proves; render the Inertia badge in
the entries table (parity with the cache badge); data-drive the props rows. Adds a
committed cross-repo wire-contract fixture (`inertia-render.v1.json`) so producer
drift fails a test.
