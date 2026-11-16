---
'@dudousxd/nestjs-telescope-ui': minor
---

Monitor → Fleet page (also in ⌘K), shown where the server keeps a fleet: per app the instance counts and send buffer, every instance, the deploy timeline with rollout progress, restart loops, and failing checks with the exception families recorded since (click to open the entry). Follows the App picker and re-reads every 15 s. New client types and `TelescopeClient.fleet()` / `useFleet()`.
