---
'@dudousxd/nestjs-telescope-ui': patch
---

Serve the dashboard `index.html` with `Cache-Control: no-store` and the hashed
asset bundles with a long immutable cache. Previously index.html had no cache
headers, so browsers kept loading a stale bundle across upgrades — the classic
"a widget is stuck loading / shows old labels after deploying a new version".
