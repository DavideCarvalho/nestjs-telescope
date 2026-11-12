---
"@dudousxd/nestjs-telescope-ai": major
"@dudousxd/nestjs-telescope-bullmq": major
"@dudousxd/nestjs-telescope-cache": major
"@dudousxd/nestjs-telescope-clickhouse": major
"@dudousxd/nestjs-telescope": major
"@dudousxd/nestjs-telescope-events": major
"@dudousxd/nestjs-telescope-logs": major
"@dudousxd/nestjs-telescope-mail": major
"@dudousxd/nestjs-telescope-mikro-orm": major
"@dudousxd/nestjs-telescope-mikro-orm-watcher": major
"@dudousxd/nestjs-telescope-official": minor
"@dudousxd/nestjs-telescope-otel": major
"@dudousxd/nestjs-telescope-parquet": major
"@dudousxd/nestjs-telescope-prisma": major
"@dudousxd/nestjs-telescope-redis": major
"@dudousxd/nestjs-telescope-redis-watcher": major
"@dudousxd/nestjs-telescope-schedule": major
"@dudousxd/nestjs-telescope-sqs": major
"@dudousxd/nestjs-telescope-testing": major
"@dudousxd/nestjs-telescope-typeorm": major
"@dudousxd/nestjs-telescope-ui": major
---

Require Node.js 24 or newer: `engines.node` is now `>=24` (was `>=20`). CI tests on Node 24 and 26. `@dudousxd/nestjs-telescope` depends on `better-sqlite3` 12.11.1 (was 11.10.0, which neither ships a prebuild for nor compiles on Node 26).

Removed, with no replacement alias (see the docs' Upgrading page):

- `@dudousxd/nestjs-telescope`: the `alerts.webhookUrl` option. Use `alerts.channels: [webhookChannel(url)]`, which sends the same payload. `alerts.channels` is now required.
- `@dudousxd/nestjs-telescope-ui`: `BarChartCard`'s `onBarClick` prop (use `onSelect`), and the `chartTheme`, `tooltipContentStyle`, `tooltipLabelStyle`, `tooltipItemStyle` and `axisTickStyle` exports (`ChartContainer` and `ChartTooltipContent` style the charts). `TelescopeMeta`'s `tracesEnabled`, `ai`, `entryTypes`, `dashboards` and `profiling` are now required, as the server always sends them.
