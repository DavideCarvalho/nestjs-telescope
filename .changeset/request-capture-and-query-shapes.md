---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Capture requests under a global prefix, and make query-shape insights actionable.

Core: the request-capture middleware no longer relies on NestJS module routing,
which silently scoped the catch-all to `/` whenever the host called
`setGlobalPrefix(...)`. New `telescopeRequestCapture(service)` factory lets hosts
register the capture globally (`app.use(...)` in bootstrap), and a
`registerRequestMiddleware: false` option disables the built-in registration.
Telescope's own dashboard routes are skipped inside the middleware instead of via
`.exclude()` (which breaks with catch-all routes). The query-family label now
tolerates content shapes that omit `slow`/`connection` (e.g. the MikroORM logger).

UI: the "Slowest query shapes" chart uses a horizontal, truncated layout (full
SQL on hover) so long labels no longer overlap, and each bar is clickable —
drilling into the entries list filtered to that query family.
