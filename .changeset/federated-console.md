---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

A federated console: `federation: { apps: { [name]: { storage, label? } } }` lets a central console read other apps' own telescope stores in place, instead of the apps shipping their entries to it. Each app is picked like a control plane's app (`?app=<name>`, `authorize` `apps` grants) and every read route answers from its store; "All apps" merges every store with the console's own (lists newest first with a per-store cursor, counts, Pulse and rollups summed). Writes, pruning, alerts and process-bound actions (replay, EXPLAIN, live queues, schedules) stay on the central app, and the UI says so on those pages. Composes with `topology: 'control-plane'`.
