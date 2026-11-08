---
"@dudousxd/nestjs-telescope": minor
---

`Watcher` gains an optional `unregister()`, called once on application shutdown for every watcher whose `register()` succeeded (a throw is logged and swallowed), so a watcher that subscribes to `diagnostics_channel` stops recording when its app closes. New `publishAgentObservation(observation)` hands an AI usage or run observation from a source other than the `aviary:agent:*` channels (such as `@nestjs/ai`, through `@dudousxd/nestjs-telescope-official`'s `telescopeAiUsage()`) to every `subscribeAgentObservations` listener, so the Prometheus AI metrics and the otel AI exporter count it.
