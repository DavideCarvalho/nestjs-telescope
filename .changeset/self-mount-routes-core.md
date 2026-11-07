---
"@dudousxd/nestjs-telescope": minor
---

Add `routes: false` to `TelescopeModule.forRoot` / `forRootAsync` (static top-level on the async variant): the module mounts no controller and every provider keeps running, so you serve the routes from your own controllers, protected with `@Can(...)` / `@UseGuards(...)`. The module now exports what those controllers need (`TELESCOPE_OPTIONS`, `TELESCOPE_CONFIG`, `TELESCOPE_DASHBOARD_AUTH`, `EntryEvents`, `TelescopeGuard`, `TelescopeActionGuard`, `TelescopePruner`, `AiUsageService`, `QueueManagerRegistry`, `ScheduleManagerRegistry` on top of the existing exports), and `StreamController` / `EntryEvents` are now exported from the package, so `@Controller('ops/telescope/api') class ConsoleApi extends TelescopeController {}` works. Also fixes `forRootAsync` not applying `decorators` to `TelescopeAuthController`.
