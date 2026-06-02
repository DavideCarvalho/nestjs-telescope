---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add `@dudousxd/nestjs-telescope-ui`: a bundled React dashboard served by
`TelescopeUiModule` (no host frontend deps), with an Entries view (type tabs,
polling) and correlated entry detail. The same building blocks are exported at
`/react` (components + hooks) and `/client` (typed API client) so consumers can
compose their own dashboard. Core's request middleware now also excludes the
`/telescope` UI routes from capture.
