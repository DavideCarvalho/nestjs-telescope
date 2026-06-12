# @dudousxd/nestjs-telescope-inertia-watcher

## 1.7.1

## 1.7.0

### Minor Changes

- [`b35cc6b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b35cc6b1508e98f75f2ed78b8d08b93569f47089) - Add `@dudousxd/nestjs-telescope-inertia-watcher`: an `InertiaWatcher` that
  subscribes to the `nestjs-inertia:render` diagnostics channel and records one
  `inertia` entry per Inertia render (component, resolved props, deferred/merge
  classification, partial-reload decision, asset version + 409 version-mismatch,
  history flags, page size), correlated to the request batch. Adds the
  `EntryType.Inertia` constant to core. Fully decoupled from `nestjs-inertia` —
  the channel name and payload shape (`v: 1`) are the only contract; malformed or
  wrong-version messages are dropped.

### Patch Changes

- [`10c76f1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/10c76f1c0d9c1034e5bffca2d9775cd16e553200) - Inertia panel polish: log on record failure (was silently swallowed) and warn once on
  an unsupported diagnostic version; collapse `InertiaContent` to
  `Omit<InertiaRenderDiagnostic, …>` with a destructure-rest copy; make the
  `isInertiaDiagnostic` guard honest about what it proves; render the Inertia badge in
  the entries table (parity with the cache badge); data-drive the props rows. Adds a
  committed cross-repo wire-contract fixture (`inertia-render.v1.json`) so producer
  drift fails a test.
