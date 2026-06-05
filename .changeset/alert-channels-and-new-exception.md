---
'@dudousxd/nestjs-telescope': minor
---

Pluggable alert channels + a `new-exception` rule.

Alerting now fans each fired alert out to one or more **channels** instead of a single webhook:

- `slackChannel(url, options?)` — Slack Block Kit message (severity header, fielded context, truncated stack, and an "Open in Telescope" deep-link button when `alerts.dashboardUrl` is set)
- `webhookChannel(url)` — raw JSON POST (the v1 behavior, unchanged)
- `customChannel(fn, name?)` — your own async sink (email, SNS, PagerDuty, …)

Channels fan out concurrently; one channel failing never blocks the others, and failures are warn-logged (rate-limited per channel) and never thrown into the host.

A new `{ type: 'new-exception', window }` rule fires the first time an exception's error family is seen within `window`. It evaluates per-flush (so a brand-new error pages quickly) and carries rich context pulled from the exception entry and its sibling request entry in the same batch (class, message, stack, route/method/status/duration, user, occurrence count, entry + batch ids). Dedup is a bounded per-replica in-memory map (same family may alert once per pod).

Backward compatible: the legacy `alerts.webhookUrl` is still accepted (folded into a `webhookChannel`), and the raw-webhook payload only gained additive optional fields.
