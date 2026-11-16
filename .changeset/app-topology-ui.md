---
'@dudousxd/nestjs-telescope-ui': minor
---

App picker in the console header (a control plane receiving several apps' entries; hidden otherwise), an App column in the entries table when several apps are in view, and `?app=` sent on every call. The live tail now sends the console's `?tenant=` / `?app=` too. New client exports: `pageApp`, `withConsoleScope`, `NO_APPS`, `TelescopeClient.apps()` and `useApps()`.
