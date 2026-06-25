# Skill spec — nestjs-telescope

Autonomous compressed discovery. No maintainer interview was run (fully autonomous
constraint); everything below is grounded in README.md, DESIGN.md, docs/observability.md,
website/content/docs/**, and packages/{core,ui}/src.

## Scope decision

The monorepo publishes 18 packages, but a consumer always imports two:
`@dudousxd/nestjs-telescope` (core module) and `@dudousxd/nestjs-telescope-ui`
(dashboard). All other packages are opt-in watcher/storage/adapter add-ons. Skills
therefore target ONLY the two primary client-facing packages, with the watcher and
storage add-ons summarized inside the core skills and the full list recorded in gaps.

## Skill set (flat; all type `core`)

Core package — `packages/core/skills/`:
1. `telescope-setup` — forRoot/forRootAsync, enabled, authorizer, path, prune, the
   SQLite default and swapping storage, the production-gate 403, setGlobalPrefix.
2. `telescope-watchers` — the Watcher SPI, ctx.record correlation, HttpClientWatcher,
   adding watcher packages, the safeRecord rule, instrument() escape hatch.
3. `telescope-storage-retention` — StorageProvider SPI, prune.perType, archive sink,
   redact keys/paths, sampling rules, shared store for multi-instance.
4. `telescope-alerts-ai` — alerts channels/rules helpers, the 4xx capture default,
   AI diagnoser wiring (createAiSdkDiagnoser), clientErrors.
5. `telescope-access-mcp` — authorizer vs authorizeAction, dashboardAuth modes, MCP gating.

UI package — `packages/ui/skills/`:
6. `telescope-ui-dashboard` — TelescopeUiModule.forRoot/forRootAsync, path matching,
   createTelescopeClient, the /react and /client subpath exports.

## Highest-value AI-agent guidance (what to get right)

- Production gate: the API returns 403 in prod unless `enabled:true` AND an `authorizer`
  (or dashboardAuth) is set. Agents commonly leave it default and then "the dashboard 404s/403s".
- Path coherence: `TelescopeModule` and `TelescopeUiModule` paths must match; in
  `forRootAsync` the `path` is a static sibling option, NOT returned from the factory.
- Watchers: only request+exception are automatic; everything else is an explicit
  `watchers: [...]` entry. `ctx.record()` is fire-and-forget — never `await`ed.
- 4xx exceptions: by default a 4xx HttpException is NOT an exception entry; agents that
  "expect every 403 in the exceptions tab" are wrong unless `exceptions.captureHttp4xx:true`.
- Mutations: `authorizeAction` defaults to deny — queue retry/remove/promote 403 until set.

## Remaining Gaps (interview substitutes)

- Maintainer priority ordering of the add-on packages is unknown.
- No GitHub issue mining performed this session, so real-world failure frequencies are inferred
  from source comments (which are unusually detailed) rather than from issue reports.
- Dedicated skills for the watcher/storage add-on packages (mikro-orm, prisma, bullmq, redis,
  ai, otel, testing) were deliberately out of scope; their wiring is only summarized in core skills.
- Whether the forRootAsync static-`path` constraint is a frequent real-world trap is assumed
  from the code comments, not confirmed by telemetry.
