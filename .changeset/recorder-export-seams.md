---
"@dudousxd/nestjs-telescope": minor
---

Add observability export seams used by `@dudousxd/nestjs-telescope-otel`. The `Recorder` gains a best-effort `onRecorded(input)` hook fired at the top of `record()` — before pause/sampling — so a metrics consumer gets complete counts even under overload. The `TelescopeExtension` SPI gains optional `observeRecord(input)` / `observeFlush(entries)` hooks, and `ExtensionRegistry` fans every record and every stored flush out to them (`notifyRecord` / `notifyFlush`), each isolated so a misbehaving observer can never break capture or the flush. Existing behavior is unchanged when no extension uses the hooks.
