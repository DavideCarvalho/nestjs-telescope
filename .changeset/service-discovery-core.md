---
'@dudousxd/nestjs-telescope': minor
---

Service discovery: `fetch('http://billing/invoices/1')` reaches the app named `billing`. Heartbeats carry the app's URL (`fleet.url`, default `APP_URL`). A control plane serves the map at `GET <path>/api/discovery` (long poll, scoped by the tenant token's `telescope:discovery[:<app>]` capabilities) and resolves names from it itself. A tenant reads it with no config, keeps a snapshot for when the control plane is down, and `discovery.apps` is a static map (a standalone app's directory, or a local override). The rewrite is composed onto Node's global `fetch` dispatcher (`.1` and `.2` slots), only touches single-label hosts that name an app, and is checked at startup. `strict`, `failFast`, `passthrough`, `nodeHttp` and `serverUrl` options. Other libraries read `{ resolve, appOf, subscribe }` from `globalThis[Symbol.for('@dudousxd/aviary:discovery')]`.
