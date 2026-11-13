---
"@dudousxd/nestjs-telescope-official": minor
---

`resilienceTelescopeExtension()`: a **Resilience** page built from the `NestResilienceWatcher` entries and the live `@nestjs/resilience` `ResilienceService`. It shows open and half-open circuits, refusals, retries, timeouts, bulkhead and rate-limit rejections over the window with deltas, a circuits table, events over time, the noisiest policies (click to filter the page), bulkheads, outbound rate limits and recent breaker transitions. Open circuits get a **Reset** button (confirmation, console `authorize`, `mutations: true`, audit line and a `circuit-reset` entry), and the dev MCP endpoint gets `telescope_resilience_circuits` and `telescope_resilience_reset_circuit`. `reset: false` turns the reset off; `window` sets the period.
