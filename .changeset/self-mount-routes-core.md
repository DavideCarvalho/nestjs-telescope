---
"@dudousxd/nestjs-telescope": major
---

Add `routes: false` to `TelescopeModule.forRoot` / `forRootAsync` (static top-level on the async variant): the module mounts no controller and every provider keeps running, so you serve the routes from your own controllers, protected with `@Can(...)` / `@UseGuards(...)`. The module now exports what those controllers need (`TELESCOPE_OPTIONS`, `TELESCOPE_CONFIG`, `EntryEvents`, `TelescopePruner`, `AiUsageService`, `QueueManagerRegistry`, `ScheduleManagerRegistry` on top of the existing exports), and `StreamController` / `EntryEvents` are now exported from the package, so `@Controller('ops/telescope/api') class ConsoleApi extends TelescopeController {}` works. The exported controllers carry no guard of their own, so a subclass's decorators are its whole gate.
