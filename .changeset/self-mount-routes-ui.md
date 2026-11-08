---
"@dudousxd/nestjs-telescope-ui": major
---

Add `routes: false` to `TelescopeUiModule.forRoot` / `forRootAsync` (static top-level on the async variant): no controller is mounted, and `TelescopeUiController` and `TELESCOPE_UI_OPTIONS` are now exported (the module exports the options provider), so you can serve the page from your own subclass protected with `@Can(...)` / `@UseGuards(...)`.
