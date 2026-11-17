---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Honest watcher state on a control plane. Every heartbeat now carries the watchers its process runs (`watchers`), and on a control plane `GET meta` lists the union of what the instances of the apps in view report (narrowed by `?app=` and the viewer's `apps` grant, plus the control plane's own when every app is in view) instead of the control plane's own list, which says nothing about the tenants whose entries are on screen. Before, a control plane without a `query` watcher hid the Queries nav item of tenants that record queries. When an app in view runs an older version that does not report its watchers, or the fleet is off (`fleet: false`), `watchers` is left out and the console claims nothing (every type shows). A standalone app is unchanged.

`TelescopeMeta.watchers` becomes optional; `TelescopeService.enabledWatchers()` returns this process's list. The Overview's N+1 and Slowest jobs cards say "Not measured" when `meta.watchers` positively lacks the `query` / `job` watcher, instead of "None detected".
