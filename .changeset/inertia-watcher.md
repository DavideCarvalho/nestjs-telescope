---
"@dudousxd/nestjs-telescope-inertia-watcher": minor
"@dudousxd/nestjs-telescope": minor
---

Add `@dudousxd/nestjs-telescope-inertia-watcher`: an `InertiaWatcher` that
subscribes to the `nestjs-inertia:render` diagnostics channel and records one
`inertia` entry per Inertia render (component, resolved props, deferred/merge
classification, partial-reload decision, asset version + 409 version-mismatch,
history flags, page size), correlated to the request batch. Adds the
`EntryType.Inertia` constant to core. Fully decoupled from `nestjs-inertia` —
the channel name and payload shape (`v: 1`) are the only contract; malformed or
wrong-version messages are dropped.
