---
'@dudousxd/nestjs-telescope-ui': minor
---

Ship the console launcher on its own subpath: `@dudousxd/nestjs-telescope-ui/react/console`.

The launcher was only reachable from the `./react` barrel, which re-exports the whole dashboard
component set and therefore pulls in `recharts` and `react-router-dom`. Neither is declared by this
package, and a bundler resolves re-exported modules even when nothing references them — so a host
that wanted nothing but the launcher button got a hard build failure on a missing dependency
instead of tree-shaking it away.

`./react/console` re-exports the hook, the button and the headless client primitives, and nothing
else. Its entire dependency footprint is `react`, guarded by a test that walks the import graph.

`./react` is unchanged and still exports the launcher, so nothing breaks.
