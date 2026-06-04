---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Two dashboard additions:

- **Slow outgoing HTTP hotspots.** The `http_client` watcher now records a
  grouping `familyHash` of `${method} ${host}${normalizedPath}` (via a new
  `normalizeHttpTarget` helper that keeps the host and `:id`-normalizes the
  path), so outbound calls to the same external endpoint aggregate regardless of
  ids. Pulse gains `slowOutgoing: SlowRouteHotspot[]` — top-N external targets by
  p99 (count + p99/p50 over `durationMs`), computed entirely from content-less
  columns (no hydration). The UI renders a "Slow outgoing HTTP" section in the
  Pulse panel, each row deep-linking to `#/entries/http_client?familyHash=…`.

- **Server stats card.** A read-guarded `GET /telescope/api/server-stats`
  endpoint returns a point-in-time Node process-health snapshot
  (`uptimeSec`, `memory` RSS/heap MB, `cpu` user/system ms, `eventLoopDelayMs`,
  `instanceId`). Event-loop delay is read from a `perf_hooks.monitorEventLoopDelay`
  histogram started once at service init and degrades to `null` when unavailable.
  The UI Overview page shows a polled "Server" card (honors pause) via the new
  `serverStats()` client method and `useServerStats()` hook.
