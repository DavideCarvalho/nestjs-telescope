---
'@dudousxd/nestjs-telescope': minor
---

One Telescope for many apps. New `topology` option: `'standalone'` (default, unchanged), `'control-plane'` (also stores the entries tenant apps send to `POST <path>/api/ingest`, tagged `app:<partition>` from the token checked by `verifyTenant`) and `'tenant'` (sends this app's entries to a control plane with `tenant: { url, partition, token }`, buffered, batched and retried; `tenant.local` keeps a local copy). `hmacTenantVerifier` / `signTenantToken` give a shared-secret token with no identity provider (same format as nestjs-durable's). `transports.http` is the default transport.

The console gets an App dimension: `authorize` (and `authorizeByToken`) may grant `apps: '*' | string[]`, every read (entries, traces, metrics, Pulse, live tail, ⌘K search, MCP tools) follows it and `?app=`, global actions are refused to an app-limited viewer, and `GET <path>/api/apps` lists the apps with `apps.labels`. Inside an organization or app view, rollups are no longer read (they are not tagged), so latency percentiles come from the view's own entries. A throwing `authorize` hook is now logged with its stack.
