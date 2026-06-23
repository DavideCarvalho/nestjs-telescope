---
"@dudousxd/nestjs-telescope-mikro-orm": minor
---

Add a `silent` option to `telescopeMikroOrmLogger` so queries can be captured without spamming the console.

MikroORM only calls the logger while `debug` is enabled, but `debug` also echoes every query to stdout — which makes local debugging painful once Telescope is wired in. Passing `{ silent: true }` swaps MikroORM's writer for a no-op so queries still flow into Telescope (correlated to the active ALS batch, slow-tagged, hashed for N+1) while nothing is printed:

```ts
loggerFactory: telescopeMikroOrmLogger(
  (input) => telescope.record(input),
  { slowMs: 100, silent: true },
),
```

`silent` defaults to `false`, preserving the previous tee-to-console behavior.
