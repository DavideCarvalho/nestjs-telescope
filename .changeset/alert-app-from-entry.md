---
"@dudousxd/nestjs-telescope": minor
---

Alerts about an exception name the app that recorded it (its `app:` tag, else its sibling request's) instead of the server that evaluated the rule: on a control plane, a tenant's exception used to be reported as the control plane. The exception context carries `app` (`null` when untagged); the integrations' `App` and incident key use it ahead of `alerts.app`, and the Slack card adds an `App` field. An untagged exception behaves as before.
